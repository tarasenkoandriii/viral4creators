/**
 * Executor — исполнитель попыток в изолированном контейнере (без сети,
 * read-only root FS, non-root). Файловый протокол — `src/contracts.ts` и
 * `./protocol.ts`.
 *
 *  - Одна попытка за раз; шаги последовательно; отказ шага N → `failed`
 *    с `failedStep = N`.
 *  - ffmpeg — фиксированный бинарник через argv (`spawn`, без shell),
 *    `cwd` = каталог попытки, `detached` (своя группа процессов), env из
 *    белого списка. `-progress pipe:1` → heartbeat в state.json.
 *  - Дедлайн/отмена/превышение записи → `kill(-pgid)` и подтверждение,
 *    что в группе не осталось процессов.
 *  - done.json пишется атомарно; OOM (SIGKILL + признаки) → `oom`.
 */
import { spawn, spawnSync } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  ExecutorDone,
  ExecutorRequest,
  ExecutorState,
} from '../contracts';
import {
  ALLOWED_FILTERS,
  DENIED_FILTERS,
  FILE_OPTION_KEYS,
  INPUT_DEMUXERS,
} from '../command/allowlist';
import { parseFiltergraph } from '../command/filtergraph';
import { runFfprobe } from '../probe/probe';
import {
  AbandonedMarker,
  CAPABILITIES_FILE,
  CONTROL,
  ExecutorCapabilities,
  ExecutorHeartbeat,
  HEARTBEAT_FILE,
  ID_PATTERN,
  ProbeRequest,
  ProbeResponse,
  controlPath,
  executorDir,
  exists,
  readJson,
  writeJsonAtomic,
} from './protocol';
import {
  dirBytes,
  groupMembers,
  killGroup,
  readOomKillCount,
  sampleProc,
} from './proc';

export interface ExecutorOptions {
  workspaceRoot: string;
  ffmpegBin: string;
  ffprobeBin: string;
  /** Пауза между сканированиями очереди. */
  pollMs?: number;
  /** Период heartbeat (глобального и попытки). */
  heartbeatMs?: number;
  /** Период проверки отмены/дедлайна/размера во время шага. */
  monitorMs?: number;
  /** Каталог для HOME/кеша fontconfig ffmpeg (tmpfs). */
  tmpDir?: string;
  /** Переменные, передаваемые ffmpeg как есть (FONTCONFIG_FILE, …). */
  passEnv?: Record<string, string | undefined>;
  log?: (msg: string) => void;
}

/** Дополнительные поля state.json (сверх контракта) для восстановления. */
interface StateExtra {
  executorInstance: string;
  procStartTime: number | null;
  /**
   * Ресурсы для overview (контейнер API не видит /proc executor):
   * cpuMs — CPU попытки нарастающим итогом (завершённые шаги + текущий),
   * rssKb — текущий VmRSS ffmpeg, peakRssKb — максимум VmHWM за попытку,
   * sampledAt — время замера (epoch ms). null — замера ещё не было.
   */
  cpuMs: number | null;
  rssKb: number | null;
  peakRssKb: number | null;
  sampledAt: number | null;
}

const PASS_ENV_KEYS = ['FONTCONFIG_FILE', 'FONTCONFIG_PATH'] as const;

/** Требуемые корпусом компоненты сборки. */
export const REQUIRED_ENCODERS = ['libx264', 'aac', 'mjpeg'];
export const REQUIRED_MUXERS = ['mp4', 'ipod', 'image2', 'null'];

const WORKSPACE_PATH = /^(inputs|outputs|work)\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Опции CLI, читающие/пишущие файлы по своему значению (вторая линия). */
const DENIED_CLI = new Set([
  '-filter_script',
  '-filter_complex_script',
  '-attach',
  '-dump_attachment',
  '-report',
  '-progress',
  '-passlogfile',
  '-vstats_file',
  '-sdp_file',
  '-lavfi',
  '-af',
]);

/**
 * Вторая, независимая от parseJob проверка фильтрграфа (FF-SEC-01): ключи
 * `/…` (значение из файла), запрещённые фильтры и файловые опции только
 * внутри попытки.
 */
export function validateFiltergraphArg(graph: string): string | null {
  const g = parseFiltergraph(graph);
  if (!g.ok) return `unparsable filtergraph: ${g.message}`;
  for (const f of g.filters) {
    if (DENIED_FILTERS.has(f.name)) return `filter ${f.name} is not allowed`;
    if (f.name === 'drawtext') {
      const expansion = f.options.find((o) => o.key === 'expansion')?.value;
      const text = f.options.find((o) => o.key === 'text')?.value ?? '';
      if (expansion !== 'none' && text.includes('%')) {
        return 'drawtext text with % requires expansion=none';
      }
    }
    for (const o of f.options) {
      if (o.key !== null && o.key.startsWith('/')) {
        return 'filter option loading a file (/key) is not allowed';
      }
      const fileKey = o.key !== null && FILE_OPTION_KEYS.has(o.key);
      const subtitlesPos =
        f.name === 'subtitles' && o.key === null && o.position === 0;
      if (
        o.key === 'fontfile' ||
        o.key === 'textfile' ||
        o.key === 'fontsdir'
      ) {
        return `filter option ${o.key} is not allowed`;
      }
      if ((fileKey || subtitlesPos) && !WORKSPACE_PATH.test(o.value)) {
        return 'filter file option outside the attempt';
      }
    }
  }
  return null;
}

/** argv шага: только относительные пути внутри попытки. */
export function validateStepArgv(argv: unknown): string | null {
  if (!Array.isArray(argv) || argv.length === 0) return 'empty argv';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (typeof a !== 'string') return 'non-string argument';
    if (a.includes('\u0000')) return 'NUL in argument';
    if (
      a.startsWith('/') ||
      a.startsWith('file:') ||
      /^[a-z][a-z0-9+.-]*:\/\//i.test(a)
    ) {
      return 'absolute path or URL in argument';
    }
    if (a.startsWith('-/'))
      return 'option loading a file (-/opt) is not allowed';
    if (DENIED_CLI.has(a.split(':')[0])) return `option ${a} is not allowed`;
    if (a === '-i') {
      const v = argv[i + 1];
      if (typeof v !== 'string' || !WORKSPACE_PATH.test(v)) {
        return 'invalid -i path';
      }
    }
    if (a === '-vf' || a === '-filter_complex') {
      const v = argv[i + 1];
      if (typeof v !== 'string') return `${a} without a value`;
      const p = validateFiltergraphArg(v);
      if (p) return p;
      i++;
    }
  }
  return null;
}

/** Значения -threads/-filter_*threads не выше лимита попытки. */
export function clampThreadArgs(argv: string[], max: number): string[] {
  const out = [...argv];
  for (let i = 0; i < out.length - 1; i++) {
    if (/^-(threads|filter_threads|filter_complex_threads)$/.test(out[i])) {
      const n = Number(out[i + 1]);
      if (!Number.isInteger(n) || n <= 0 || n > max) out[i + 1] = String(max);
    }
  }
  return out;
}

/** Хвост stderr без путей вне workspace, ≤ maxBytes (UTF-8). */
export function sanitizeStderr(
  raw: string,
  attemptDir: string,
  maxBytes: number,
): string {
  let s = raw.split(attemptDir + path.sep).join('');
  s = s.split(attemptDir).join('.');
  s = s.replace(/(^|[\s'"=(:])\/(?:[^\s'":,)]+)/g, '$1<path>');
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= maxBytes) return s;
  let start = buf.length - maxBytes;
  // Не резать посреди символа UTF-8.
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++;
  return buf.subarray(start).toString('utf8');
}

class TailBuffer {
  private chunks: Buffer[] = [];
  private size = 0;
  constructor(private readonly max: number) {}
  push(b: Buffer): void {
    this.chunks.push(b);
    this.size += b.length;
    while (
      this.size - this.chunks[0].length >= this.max &&
      this.chunks.length > 1
    ) {
      this.size -= this.chunks.shift()!.length;
    }
  }
  text(): string {
    const all = Buffer.concat(this.chunks);
    return all.subarray(Math.max(0, all.length - this.max)).toString('utf8');
  }
}

type StopReason = 'canceled' | 'timeout' | 'too_large' | null;

export class Executor {
  readonly instanceId = randomUUID();
  private readonly startedAt = Date.now();
  private ffmpegVersion: string | null = null;
  private busyAttemptId: string | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  /** Группа текущего шага (для остановки executor). */
  private currentPgid: number | null = null;
  private currentAttempt: { dir: string; attemptId: string } | null = null;
  private readonly log: (m: string) => void;
  /** CPU завершённых шагов текущей попытки (для state.cpuMs). */
  private cpuBaseMs = 0;

  constructor(private readonly opts: ExecutorOptions) {
    this.log = opts.log ?? (() => undefined);
  }

  get version(): string | null {
    return this.ffmpegVersion;
  }

  private get root(): string {
    return path.resolve(this.opts.workspaceRoot);
  }

  /** Подготовка: версия ffmpeg, восстановление брошенных попыток, heartbeat. */
  async init(opts: { capabilities?: boolean } = {}): Promise<void> {
    await fsp.mkdir(executorDir(this.root), { recursive: true });
    this.ffmpegVersion = readFfmpegVersion(this.opts.ffmpegBin);
    await this.recoverAbandoned();
    await this.writeHeartbeat();
    this.heartbeatTimer = setInterval(
      () => void this.writeHeartbeat().catch(() => undefined),
      this.opts.heartbeatMs ?? 1000,
    );
    this.heartbeatTimer.unref();
    if (opts.capabilities !== false) {
      await this.selfTest().catch((e) =>
        this.log(`capability self-test error: ${String(e)}`),
      );
    }
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    const cur = this.currentAttempt;
    if (this.currentPgid !== null) await killGroup(this.currentPgid);
    if (cur && !(await exists(controlPath(cur.dir, CONTROL.done)))) {
      const marker: AbandonedMarker = {
        version: 1,
        attemptId: cur.attemptId,
        pgid: this.currentPgid,
        killed: this.currentPgid !== null,
        confirmedAt: Date.now(),
      };
      await writeJsonAtomic(
        controlPath(cur.dir, CONTROL.abandoned),
        marker,
      ).catch(() => undefined);
    }
  }

  /** Главный цикл: до `signal.aborted`. */
  async loop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted && !this.stopping) {
      let worked = false;
      try {
        worked = await this.tick();
      } catch (e) {
        this.log(`executor tick error: ${String(e)}`);
      }
      if (!worked) {
        await new Promise<void>((r) => {
          const t = setTimeout(r, this.opts.pollMs ?? 500);
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(t);
              r();
            },
            { once: true },
          );
        });
      }
    }
  }

  /** Один проход: probe-запросы, затем одна попытка. true — была работа. */
  async tick(): Promise<boolean> {
    const dirs = await this.attemptDirs();
    let worked = false;
    for (const dir of dirs) {
      if (await this.serveProbe(dir)) worked = true;
    }
    const next = await this.pickNext(dirs);
    if (next) {
      await this.runAttempt(next.dir, next.req);
      worked = true;
    }
    return worked;
  }

  private async attemptDirs(): Promise<string[]> {
    const out: string[] = [];
    let jobs: string[];
    try {
      jobs = await fsp.readdir(this.root);
    } catch {
      return out;
    }
    for (const job of jobs) {
      if (!ID_PATTERN.test(job)) continue;
      let attempts: string[];
      try {
        attempts = await fsp.readdir(path.join(this.root, job));
      } catch {
        continue;
      }
      for (const a of attempts) {
        if (ID_PATTERN.test(a)) out.push(path.join(this.root, job, a));
      }
    }
    return out;
  }

  private async pickNext(
    dirs: string[],
  ): Promise<{ dir: string; req: ExecutorRequest } | null> {
    const candidates: Array<{ dir: string; mtime: number }> = [];
    for (const dir of dirs) {
      const reqFile = controlPath(dir, CONTROL.request);
      let st;
      try {
        st = await fsp.stat(reqFile);
      } catch {
        continue;
      }
      if (
        (await exists(controlPath(dir, CONTROL.done))) ||
        (await exists(controlPath(dir, CONTROL.state))) ||
        (await exists(controlPath(dir, CONTROL.abandoned))) ||
        (await exists(controlPath(dir, 'claim')))
      ) {
        continue;
      }
      candidates.push({ dir, mtime: st.mtimeMs });
    }
    candidates.sort((a, b) => a.mtime - b.mtime);
    for (const c of candidates) {
      // Атомарный захват: второй executor (если по ошибке запущен) не возьмёт.
      try {
        await fsp.writeFile(controlPath(c.dir, 'claim'), this.instanceId, {
          flag: 'wx',
        });
      } catch {
        continue;
      }
      const req = await readJson<ExecutorRequest>(
        controlPath(c.dir, CONTROL.request),
      );
      return { dir: c.dir, req: req as ExecutorRequest };
    }
    return null;
  }

  /** Выполнить попытку целиком и записать done.json. */
  async runAttempt(
    dir: string,
    req: ExecutorRequest | null,
  ): Promise<ExecutorDone> {
    const attemptId = path.basename(dir);
    const started = Date.now();
    const finish = async (
      d: Omit<
        ExecutorDone,
        'version' | 'attemptId' | 'wallMs' | 'ffmpegVersion' | 'finishedAt'
      >,
    ) => {
      const done: ExecutorDone = {
        version: 1,
        attemptId,
        ...d,
        wallMs: Date.now() - started,
        ffmpegVersion: this.ffmpegVersion,
        finishedAt: Date.now(),
      };
      await writeJsonAtomic(controlPath(dir, CONTROL.done), done);
      return done;
    };
    const empty = {
      exitCode: null,
      signal: null,
      cpuMs: null,
      peakRssKb: null,
    };

    const problem = validateRequest(req, attemptId);
    if (problem || !req) {
      return finish({
        outcome: 'failed',
        failedStep: null,
        ...empty,
        stderrTail: `invalid request: ${problem}`,
      });
    }
    this.busyAttemptId = attemptId;
    this.currentAttempt = { dir, attemptId };
    await this.writeHeartbeat().catch(() => undefined);
    const extra: StateExtra = {
      executorInstance: this.instanceId,
      procStartTime: null,
      cpuMs: null,
      rssKb: null,
      peakRssKb: null,
      sampledAt: null,
    };
    const state: ExecutorState & StateExtra = {
      version: 1,
      attemptId,
      status: 'running',
      pid: null,
      startedAt: started,
      heartbeatAt: Date.now(),
      stepIndex: 0,
      outTimeSec: null,
      ...extra,
    };
    const writeState = () =>
      writeJsonAtomic(controlPath(dir, CONTROL.state), {
        ...state,
        heartbeatAt: Date.now(),
      });
    try {
      await writeState();
      for (const sub of ['work', 'outputs']) {
        await fsp.mkdir(path.join(dir, sub), { recursive: true });
      }
      if (await exists(controlPath(dir, CONTROL.cancel))) {
        return await finish({
          outcome: 'canceled',
          failedStep: null,
          ...empty,
          stderrTail: '',
        });
      }
      if (Date.now() >= req.deadlineAt) {
        return await finish({
          outcome: 'timeout',
          failedStep: null,
          ...empty,
          stderrTail: '',
        });
      }
      let cpuTotal = 0;
      let peak: number | null = null;
      let tail = '';
      for (let i = 0; i < req.steps.length; i++) {
        const stop = (await exists(controlPath(dir, CONTROL.cancel)))
          ? 'canceled'
          : Date.now() >= req.deadlineAt
            ? 'timeout'
            : null;
        if (stop) {
          return await finish({
            outcome: stop,
            failedStep: i,
            exitCode: null,
            signal: null,
            cpuMs: cpuTotal,
            peakRssKb: peak,
            stderrTail: tail,
          });
        }
        state.stepIndex = i;
        state.outTimeSec = null;
        this.cpuBaseMs = cpuTotal;
        const r = await this.runStep(dir, req, i, state, writeState);
        cpuTotal += r.cpuMs ?? 0;
        state.cpuMs = cpuTotal;
        state.rssKb = null;
        if (r.peakRssKb !== null) peak = Math.max(peak ?? 0, r.peakRssKb);
        tail = sanitizeStderr(r.stderr, dir, req.stderrTailBytes);
        const common = {
          exitCode: r.exitCode,
          signal: r.signal,
          cpuMs: cpuTotal,
          peakRssKb: peak,
          stderrTail: tail,
        };
        if (r.stop) {
          return await finish({ outcome: r.stop, failedStep: i, ...common });
        }
        if (r.oom)
          return await finish({ outcome: 'oom', failedStep: i, ...common });
        if (r.exitCode !== 0) {
          return await finish({ outcome: 'failed', failedStep: i, ...common });
        }
      }
      return await finish({
        outcome: 'succeeded',
        failedStep: null,
        exitCode: 0,
        signal: null,
        cpuMs: cpuTotal,
        peakRssKb: peak,
        stderrTail: tail,
      });
    } finally {
      state.status = 'exited';
      state.pid = null;
      await writeState().catch(() => undefined);
      this.busyAttemptId = null;
      this.currentAttempt = null;
      this.currentPgid = null;
      await this.writeHeartbeat().catch(() => undefined);
    }
  }

  private env(): NodeJS.ProcessEnv {
    const tmp = this.opts.tmpDir ?? '/tmp';
    const env: NodeJS.ProcessEnv = {
      PATH: '/usr/bin:/bin',
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      TZ: 'UTC',
      HOME: path.join(tmp, 'ffmpeg-home'),
      XDG_CACHE_HOME: path.join(tmp, 'ffmpeg-cache'),
      TMPDIR: tmp,
    };
    const pass = this.opts.passEnv ?? {};
    for (const k of PASS_ENV_KEYS) {
      const v = pass[k];
      if (v) env[k] = v;
    }
    return env;
  }

  private async runStep(
    dir: string,
    req: ExecutorRequest,
    index: number,
    state: ExecutorState & StateExtra,
    writeState: () => Promise<void>,
  ): Promise<{
    exitCode: number | null;
    signal: string | null;
    stop: StopReason;
    oom: boolean;
    stderr: string;
    cpuMs: number | null;
    peakRssKb: number | null;
  }> {
    const tmp = this.opts.tmpDir ?? '/tmp';
    await fsp
      .mkdir(path.join(tmp, 'ffmpeg-home'), { recursive: true })
      .catch(() => undefined);
    const oomBefore = await readOomKillCount();
    const argv = [
      '-progress',
      'pipe:1',
      '-nostats',
      ...clampThreadArgs(
        req.steps[index].argv,
        Math.max(1, Math.floor(req.maxThreads)),
      ),
    ];
    const child = spawn(this.opts.ffmpegBin, argv, {
      cwd: dir,
      detached: true,
      env: this.env(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const pgid = child.pid ?? null;
    this.currentPgid = pgid;
    state.pid = pgid;
    const tailBuf = new TailBuffer(Math.max(4096, req.stderrTailBytes * 2));
    child.stderr!.on('data', (b: Buffer) => tailBuf.push(b));
    let progressRest = '';
    child.stdout!.on('data', (b: Buffer) => {
      const lines = (progressRest + b.toString('utf8')).split('\n');
      progressRest = lines.pop() ?? '';
      for (const line of lines) {
        const m = /^out_time_us=(\d+)/.exec(line);
        if (m) state.outTimeSec = Number(m[1]) / 1e6;
      }
    });

    let spawnError: Error | null = null;
    const exited = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) => {
      child.on('error', (e) => {
        spawnError = e;
        resolve({ code: null, signal: null });
      });
      child.on('exit', (code, signal) => resolve({ code, signal }));
    });

    let stop: StopReason = null;
    let lastSample: { cpuMs: number; peakRssKb: number | null } | null = null;
    let lastHeartbeat = 0;
    let monitorBusy = false;
    const monitor = async () => {
      if (monitorBusy || stop) return;
      monitorBusy = true;
      try {
        if (pgid) {
          const s = await sampleProc(pgid);
          if (s) {
            // Выходящий процесс (зомби) отдаёт CPU, но уже без VmHWM:
            // копим максимум, а не перезаписываем последним замером.
            const prev = lastSample as {
              cpuMs: number;
              peakRssKb: number | null;
            } | null;
            lastSample = {
              cpuMs: Math.max(prev?.cpuMs ?? 0, s.cpuMs),
              peakRssKb:
                s.peakRssKb === null
                  ? (prev?.peakRssKb ?? null)
                  : Math.max(prev?.peakRssKb ?? 0, s.peakRssKb),
            };
            if (state.procStartTime === null) state.procStartTime = s.startTime;
            state.cpuMs = this.cpuBaseMs + lastSample.cpuMs;
            state.rssKb = s.rssKb;
            if (lastSample.peakRssKb !== null) {
              state.peakRssKb = Math.max(
                state.peakRssKb ?? 0,
                lastSample.peakRssKb,
              );
            }
            state.sampledAt = Date.now();
          }
        }
        let reason: StopReason = null;
        if (await exists(controlPath(dir, CONTROL.cancel))) reason = 'canceled';
        else if (Date.now() >= req.deadlineAt) reason = 'timeout';
        else if (
          (await dirBytes([
            path.join(dir, 'work'),
            path.join(dir, 'outputs'),
          ])) > req.maxWriteBytes
        ) {
          reason = 'too_large';
        }
        if (reason && !stop) {
          stop = reason;
          if (pgid) await killGroup(pgid);
        }
        if (Date.now() - lastHeartbeat >= (this.opts.heartbeatMs ?? 1000)) {
          lastHeartbeat = Date.now();
          await writeState();
        }
      } finally {
        monitorBusy = false;
      }
    };
    await writeState();
    const timer = setInterval(
      () => void monitor().catch(() => undefined),
      this.opts.monitorMs ?? 200,
    );
    const { code, signal } = await exited;
    clearInterval(timer);
    while (monitorBusy) await new Promise((r) => setTimeout(r, 10));
    // Группа должна быть пустой и после штатного выхода: ffmpeg не
    // порождает детей, но проверяем, а не предполагаем.
    if (pgid) {
      const left = await groupMembers(pgid);
      if (left.length > 0) await killGroup(pgid);
    }
    this.currentPgid = null;
    // Финальный размер — запись могла закончиться между проверками.
    if (!stop && code === 0) {
      const bytes = await dirBytes([
        path.join(dir, 'work'),
        path.join(dir, 'outputs'),
      ]);
      if (bytes > req.maxWriteBytes) stop = 'too_large';
    }
    let stderr = tailBuf.text();
    if (spawnError)
      stderr += `\nexecutor: cannot start ffmpeg: ${(spawnError as Error).message}`;
    let oom = false;
    if (!stop && signal === 'SIGKILL') {
      const oomAfter = await readOomKillCount();
      oom =
        (oomBefore !== null && oomAfter !== null && oomAfter > oomBefore) ||
        /Cannot allocate memory|Out of memory/i.test(stderr);
    } else if (
      !stop &&
      code !== 0 &&
      /Cannot allocate memory|Out of memory/i.test(stderr)
    ) {
      oom = true;
    }
    const sample = lastSample as {
      cpuMs: number;
      peakRssKb: number | null;
    } | null;
    return {
      exitCode: code,
      signal: signal ?? null,
      stop,
      oom,
      stderr,
      cpuMs: sample?.cpuMs ?? null,
      peakRssKb: sample?.peakRssKb ?? null,
    };
  }

  /** ffprobe по запросу API — внутри изолированного контейнера. */
  private async serveProbe(dir: string): Promise<boolean> {
    const req = await readJson<ProbeRequest>(
      controlPath(dir, CONTROL.probeRequest),
    );
    if (!req || typeof req.requestId !== 'string') return false;
    const prev = await readJson<ProbeResponse>(
      controlPath(dir, CONTROL.probeResult),
    );
    if (prev && prev.requestId === req.requestId) return false;
    const results: ProbeResponse['results'] = [];
    for (const file of Array.isArray(req.files) ? req.files.slice(0, 64) : []) {
      if (
        typeof file !== 'string' ||
        !/^(inputs|outputs|work)\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(file)
      ) {
        results.push({
          file: String(file),
          ok: false,
          json: null,
          error: 'invalid path',
        });
        continue;
      }
      const st = await fsp.lstat(path.join(dir, file)).catch(() => null);
      if (!st || !st.isFile()) {
        results.push({
          file,
          ok: false,
          json: null,
          error: 'not a regular file',
        });
        continue;
      }
      try {
        const json = await runFfprobe(this.opts.ffprobeBin, file, {
          cwd: dir,
          env: this.env(),
          timeoutMs: Math.min(Math.max(req.timeoutMs || 30_000, 1000), 120_000),
        });
        results.push({ file, ok: true, json, error: null });
      } catch (e) {
        results.push({
          file,
          ok: false,
          json: null,
          error: (e as Error).message.slice(0, 300),
        });
      }
    }
    const res: ProbeResponse = {
      version: 1,
      requestId: req.requestId,
      results,
      finishedAt: Date.now(),
    };
    await writeJsonAtomic(controlPath(dir, CONTROL.probeResult), res);
    return true;
  }

  /**
   * Попытки прежнего процесса без done.json: убить их группу (если это
   * всё ещё тот же процесс) и записать abandoned.json — доказательство
   * завершения для API.
   */
  async recoverAbandoned(): Promise<void> {
    for (const dir of await this.attemptDirs()) {
      if (await exists(controlPath(dir, CONTROL.done))) continue;
      if (await exists(controlPath(dir, CONTROL.abandoned))) continue;
      const state = await readJson<ExecutorState & Partial<StateExtra>>(
        controlPath(dir, CONTROL.state),
      );
      const claimed = await exists(controlPath(dir, 'claim'));
      if (!state && !claimed) continue; // ещё в очереди
      if (state?.executorInstance === this.instanceId) continue;
      let killed = false;
      const pgid = state?.pid ?? null;
      if (pgid && pgid > 1 && pgid !== process.pid) {
        const s = await sampleProc(pgid);
        const same =
          !!s &&
          (state?.procStartTime == null || s.startTime === state.procStartTime);
        const members = await groupMembers(pgid);
        if (same || (members.length > 0 && state?.procStartTime == null)) {
          killed = true;
          const ok = await killGroup(pgid);
          if (!ok) {
            this.log(
              `cannot confirm termination of group ${pgid}; attempt left without marker`,
            );
            continue;
          }
        }
      }
      const marker: AbandonedMarker = {
        version: 1,
        attemptId: path.basename(dir),
        pgid,
        killed,
        confirmedAt: Date.now(),
      };
      await writeJsonAtomic(controlPath(dir, CONTROL.abandoned), marker);
    }
  }

  async writeHeartbeat(): Promise<void> {
    const hb: ExecutorHeartbeat = {
      version: 1,
      pid: process.pid,
      startedAt: this.startedAt,
      heartbeatAt: Date.now(),
      busyAttemptId: this.busyAttemptId,
      ffmpegVersion: this.ffmpegVersion,
    };
    await writeJsonAtomic(
      path.join(executorDir(this.root), HEARTBEAT_FILE),
      hb,
    );
  }

  /** Capability self-test: компоненты корпуса и смоук-рендер libass+x264+aac. */
  async selfTest(): Promise<ExecutorCapabilities> {
    const list = (flag: string, re: RegExp): string[] => {
      const r = spawnSync(this.opts.ffmpegBin, ['-hide_banner', flag], {
        encoding: 'utf8',
        env: this.env(),
        timeout: 20_000,
      });
      const out: string[] = [];
      for (const line of (r.stdout ?? '').split('\n')) {
        const m = re.exec(line);
        if (m) out.push(...m[1].split(','));
      }
      return out;
    };
    const encoders = list('-encoders', /^\s[VAS][\w.]{5}\s+(\S+)/);
    const filters = list('-filters', /^\s[T.][S.][C.]?\s+(\S+)\s/);
    const muxers = list('-muxers', /^\s[ D]E[ d]?\s+(\S+)/);
    const demuxers = list('-demuxers', /^\sD[ E]?[ d]?\s+(\S+)/);
    const missing = [
      ...REQUIRED_ENCODERS.filter((e) => !encoders.includes(e)).map(
        (e) => `encoder:${e}`,
      ),
      ...[...ALLOWED_FILTERS]
        .filter((f) => !filters.includes(f))
        .map((f) => `filter:${f}`),
      ...REQUIRED_MUXERS.filter((m) => !muxers.includes(m)).map(
        (m) => `muxer:${m}`,
      ),
      ...[...INPUT_DEMUXERS, 'srt', 'ass']
        .filter((d) => !demuxers.includes(d))
        .map((d) => `demuxer:${d}`),
    ];
    const smoke = await this.smoke();
    const version = spawnSync(
      this.opts.ffmpegBin,
      ['-hide_banner', '-version'],
      {
        encoding: 'utf8',
        env: this.env(),
      },
    ).stdout;
    const probeVersion = spawnSync(
      this.opts.ffprobeBin,
      ['-hide_banner', '-version'],
      {
        encoding: 'utf8',
        env: this.env(),
      },
    ).stdout;
    const caps: ExecutorCapabilities = {
      version: 1,
      checkedAt: Date.now(),
      ffmpegVersion: this.ffmpegVersion,
      ffprobeVersion:
        /ffprobe version (\S+)/.exec(probeVersion ?? '')?.[1] ?? null,
      buildConfiguration:
        /configuration: (.*)/.exec(version ?? '')?.[1]?.trim() ?? null,
      encoders: encoders.filter((e) => REQUIRED_ENCODERS.includes(e)),
      filters: filters.filter((f) => ALLOWED_FILTERS.has(f)),
      muxers: muxers.filter((m) => REQUIRED_MUXERS.includes(m)),
      demuxers: demuxers.filter((d) =>
        [...INPUT_DEMUXERS, 'srt', 'ass'].includes(d),
      ),
      missing,
      smokeOk: smoke === null,
      smokeError: smoke,
      ok: missing.length === 0 && smoke === null && !!this.ffmpegVersion,
    };
    await writeJsonAtomic(
      path.join(executorDir(this.root), CAPABILITIES_FILE),
      caps,
    );
    return caps;
  }

  /** null — смоук прошёл; иначе текст ошибки. */
  private async smoke(): Promise<string | null> {
    const dir = path.join(executorDir(this.root), 'smoke');
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.mkdir(dir, { recursive: true });
    try {
      await fsp.writeFile(
        path.join(dir, 'smoke.srt'),
        '1\n00:00:00,000 --> 00:00:01,000\nПривіт, ґанок! Съешь ещё. Hello.\n',
      );
      const r = spawnSync(
        this.opts.ffmpegBin,
        [
          '-nostdin',
          '-hide_banner',
          '-v',
          'error',
          '-y',
          '-f',
          'lavfi',
          '-i',
          'testsrc=s=320x240:r=25:d=1',
          '-f',
          'lavfi',
          '-i',
          'sine=d=1',
          '-filter_complex',
          "[0:v]subtitles=smoke.srt:force_style='FontName=Arial'[v];[1:a]loudnorm[a]",
          '-map',
          '[v]',
          '-map',
          '[a]',
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-pix_fmt',
          'yuv420p',
          '-c:a',
          'aac',
          '-threads',
          '1',
          'smoke.mp4',
        ],
        { cwd: dir, env: this.env(), encoding: 'utf8', timeout: 60_000 },
      );
      if (r.status !== 0)
        return (
          sanitizeStderr(r.stderr ?? 'smoke failed', dir, 1000) ||
          'smoke failed'
        );
      const json = (await runFfprobe(this.opts.ffprobeBin, 'smoke.mp4', {
        cwd: dir,
        env: this.env(),
      })) as {
        streams?: Array<{ codec_name?: string }>;
      };
      const codecs = (json.streams ?? []).map((s) => s.codec_name);
      if (!codecs.includes('h264') || !codecs.includes('aac'))
        return 'smoke output lacks h264/aac';
      return null;
    } catch (e) {
      return (e as Error).message;
    } finally {
      await fsp
        .rm(dir, { recursive: true, force: true })
        .catch(() => undefined);
    }
  }
}

export function readFfmpegVersion(bin: string): string | null {
  const r = spawnSync(bin, ['-hide_banner', '-version'], {
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
    timeout: 10_000,
  });
  if (r.status !== 0) return null;
  return /ffmpeg version (\S+)/.exec(r.stdout ?? '')?.[1] ?? null;
}

function validateRequest(
  req: ExecutorRequest | null,
  attemptId: string,
): string | null {
  if (!req || typeof req !== 'object') return 'unreadable request';
  if (req.version !== 1) return 'unsupported version';
  if (req.attemptId !== attemptId) return 'attemptId mismatch';
  if (!Array.isArray(req.steps) || req.steps.length === 0) return 'no steps';
  for (const s of req.steps) {
    const p = validateStepArgv(s?.argv);
    if (p) return p;
  }
  for (const k of [
    'deadlineAt',
    'maxThreads',
    'stderrTailBytes',
    'maxWriteBytes',
  ] as const) {
    if (!Number.isFinite(req[k]) || req[k] <= 0) return `invalid ${k}`;
  }
  return null;
}
