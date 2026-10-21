/**
 * Общие помощники тестов CORE: конфигурация во временном каталоге,
 * фейковые порты EXEC (parse/download/probe/executor) с управляемым
 * поведением и HTTP-клиент к поднятому серверу.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  promises as fsp,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type App, createApp } from '../../src/app';
import { type ServerConfig, loadConfig } from '../../src/config';
import type {
  ExecPlan,
  ExecutorDone,
  ExecutorRequest,
  ExecutorState,
  JobRequestBody,
  ProbeResult,
} from '../../src/contracts';
import { createLogger } from '../../src/metrics/logger';
import type {
  AttemptPaths,
  ExecutorPoll,
  ExecutorPort,
  Ports,
} from '../../src/queue/ports';

export const CLIENT_KEY = 'client-key-' + 'a'.repeat(40);
export const CLIENT2_KEY = 'client2-key-' + 'b'.repeat(40);
export const OPS_KEY = 'ops-key-' + 'c'.repeat(40);
export const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export function tempDir(prefix = 'ffs-'): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

export function baseEnv(
  dir: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    FFMPEG_SERVER_DATA_DIR: path.join(dir, 'data'),
    FFMPEG_SERVER_WORKSPACE_ROOT: path.join(dir, 'workspace'),
    FFMPEG_SERVER_OUTPUTS_ROOT: path.join(dir, 'outputs'),
    FFMPEG_SERVER_PUBLIC_BASE_URL: 'https://ffmpeg.test',
    FFMPEG_SERVER_CLIENTS: JSON.stringify([
      { clientId: 'backend', role: 'client', keySha256: [sha(CLIENT_KEY)] },
      { clientId: 'other', role: 'client', keySha256: [sha(CLIENT2_KEY)] },
      { clientId: 'ops', role: 'ops', keySha256: [sha(OPS_KEY)] },
    ]),
    FFMPEG_SERVER_PAYLOAD_KEYS: JSON.stringify({
      p1: randomBytes(32).toString('base64'),
    }),
    FFMPEG_SERVER_PAYLOAD_KEY_ACTIVE: 'p1',
    FFMPEG_SERVER_HMAC_KEYS: JSON.stringify({
      h1: randomBytes(32).toString('base64'),
    }),
    FFMPEG_SERVER_HMAC_KEY_ACTIVE: 'h1',
    FFMPEG_SERVER_INPUT_ALLOWED_HOSTS: 'storage.test,*.blob.test,localhost',
    FFMPEG_SERVER_DISK_MIN_FREE_BYTES: '1024',
    FFMPEG_SERVER_DISPATCHER_TICK_MS: '20',
    FFMPEG_SERVER_EXECUTOR_POLL_MS: '20',
    FFMPEG_SERVER_EXECUTOR_HEARTBEAT_STALE_SEC: '2',
    ...extra,
  };
}

/** Ключи шифрования/HMAC стабильны для каталога — рестарт видит те же. */
export function stableEnv(
  dir: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  const file = path.join(dir, 'test-env.json');
  let env: Record<string, string>;
  if (existsSync(file))
    env = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>;
  else {
    env = baseEnv(dir);
    writeFileSync(file, JSON.stringify(env));
  }
  return { ...env, ...extra };
}

export function makeConfig(
  dir: string,
  extra: Record<string, string> = {},
): ServerConfig {
  return loadConfig(stableEnv(dir, extra));
}

/** Лог в память — проверка отсутствия секретов. */
export function memoryLogger() {
  const lines: string[] = [];
  return { lines, log: createLogger((l) => lines.push(l), 'debug') };
}

// ── Фейковый executor ──────────────────────────────────────────────────

export type FakeOutcome = ExecutorDone['outcome'];

export interface FakeBehavior {
  /** Длительность «рендера», мс. */
  durationMs: number;
  outcome: FakeOutcome;
  /** Не писать outputs при succeeded (проверка OUTPUT_MISSING). */
  skipOutputs?: boolean;
  /** «Зависнуть»: не отвечать на cancel и не завершаться. */
  hang?: boolean;
}

interface FakeAttempt {
  req: ExecutorRequest;
  dir: string;
  startedAt: number;
  canceledAt: number | null;
  behavior: FakeBehavior;
  done: ExecutorDone | null;
  abandoned: boolean;
}

export class FakeExecutor implements ExecutorPort {
  attempts = new Map<string, FakeAttempt>();
  starts: ExecutorRequest[] = [];
  behavior: (req: ExecutorRequest) => FakeBehavior = () => ({
    durationMs: 30,
    outcome: 'succeeded',
  });
  heartbeatFresh = true;
  /** Искусственная задержка readiness (дедлайн фиксации приёма). */
  statusDelayMs = 0;
  capsOk = true;
  /** Сколько попыток одновременно «исполнялось» — инвариант ≤ 1. */
  maxConcurrent = 0;

  constructor(readonly root: string) {}

  attemptDir(jobId: string, attemptId: string): string {
    return path.join(this.root, jobId, attemptId);
  }

  async prepareAttempt(
    jobId: string,
    attemptId: string,
  ): Promise<AttemptPaths> {
    const dir = this.attemptDir(jobId, attemptId);
    for (const s of ['inputs', 'work', 'outputs', 'control']) {
      await fsp.mkdir(path.join(dir, s), { recursive: true });
    }
    return {
      dir,
      inputs: path.join(dir, 'inputs'),
      work: path.join(dir, 'work'),
      outputs: path.join(dir, 'outputs'),
      control: path.join(dir, 'control'),
    };
  }

  async start(req: ExecutorRequest): Promise<void> {
    if (this.attempts.has(req.attemptId)) throw new Error('already_started');
    const dir = (await this.prepareAttempt(req.jobId, req.attemptId)).dir;
    this.starts.push(req);
    this.attempts.set(req.attemptId, {
      req,
      dir,
      startedAt: Date.now(),
      canceledAt: null,
      behavior: this.behavior(req),
      done: null,
      abandoned: false,
    });
    const running = [...this.attempts.values()].filter(
      (a) => !a.done && !a.abandoned,
    ).length;
    this.maxConcurrent = Math.max(this.maxConcurrent, running);
  }

  private async finish(a: FakeAttempt, outcome: FakeOutcome): Promise<void> {
    if (outcome === 'succeeded' && !a.behavior.skipOutputs) {
      // Каждый объявленный output — по шагу «ffmpeg … outputs/<name>».
      for (const step of a.req.steps) {
        const out = step.argv[step.argv.length - 1];
        if (out.startsWith('outputs/')) {
          await fsp.writeFile(
            path.join(a.dir, out),
            `rendered:${out}:${a.req.attemptId}`,
          );
        }
      }
    }
    a.done = {
      version: 1,
      attemptId: a.req.attemptId,
      outcome,
      failedStep: outcome === 'failed' ? 0 : null,
      exitCode: outcome === 'succeeded' ? 0 : outcome === 'failed' ? 1 : null,
      signal:
        outcome === 'canceled' || outcome === 'timeout' ? 'SIGKILL' : null,
      stderrTail:
        outcome === 'failed'
          ? 'Error https://secret.example/x?sig=abc while processing'
          : '',
      wallMs: Date.now() - a.startedAt,
      cpuMs: 5,
      peakRssKb: 1000,
      ffmpegVersion: 'fake-6.1',
      finishedAt: Date.now(),
    };
  }

  async poll(attemptId: string): Promise<ExecutorPoll> {
    const a = this.attempts.get(attemptId);
    if (!a) return { kind: 'unknown' };
    if (a.abandoned) {
      return {
        kind: 'abandoned',
        marker: {
          version: 1,
          attemptId,
          pgid: 1,
          killed: true,
          confirmedAt: Date.now(),
        },
        state: null,
      };
    }
    if (!a.done && !a.behavior.hang) {
      if (a.canceledAt) await this.finish(a, 'canceled');
      else if (Date.now() >= a.req.deadlineAt) await this.finish(a, 'timeout');
      else if (Date.now() - a.startedAt >= a.behavior.durationMs) {
        await this.finish(a, a.behavior.outcome);
      }
    }
    if (a.done) return { kind: 'done', done: a.done, state: null };
    // Поля сверх контракта — как у настоящего executor (CPU/RAM замера).
    const elapsed = Date.now() - a.startedAt;
    const state: ExecutorState & Record<string, unknown> = {
      cpuMs: elapsed,
      rssKb: 51_200,
      peakRssKb: 65_536,
      sampledAt: Date.now(),
      version: 1,
      attemptId,
      status: 'running',
      pid: 4242,
      startedAt: a.startedAt,
      heartbeatAt: Date.now(),
      stepIndex: 0,
      outTimeSec: Math.min(
        1,
        (Date.now() - a.startedAt) / Math.max(1, a.behavior.durationMs),
      ),
    };
    return { kind: 'running', state, cancelRequested: !!a.canceledAt };
  }

  async cancel(attemptId: string): Promise<void> {
    const a = this.attempts.get(attemptId);
    if (a && !a.canceledAt) a.canceledAt = Date.now();
  }

  async isAlive(attemptId: string): Promise<boolean> {
    const a = this.attempts.get(attemptId);
    return !!a && !a.done && !a.abandoned;
  }

  /** «Executor перезапустился»: незавершённые попытки — abandoned. */
  restartExecutor(): void {
    for (const a of this.attempts.values()) if (!a.done) a.abandoned = true;
  }

  async executorStatus() {
    if (this.statusDelayMs) {
      await new Promise((r) => setTimeout(r, this.statusDelayMs));
    }
    const busy = [...this.attempts.values()].find(
      (a) => !a.done && !a.abandoned,
    );
    return {
      heartbeat: {
        version: 1 as const,
        pid: 1,
        startedAt: 0,
        heartbeatAt: this.heartbeatFresh ? Date.now() : 0,
        busyAttemptId: busy?.req.attemptId ?? null,
        ffmpegVersion: 'fake-6.1',
      },
      fresh: this.heartbeatFresh,
    };
  }

  async capabilities() {
    return {
      version: 1 as const,
      checkedAt: Date.now(),
      ffmpegVersion: 'fake-6.1',
      ffprobeVersion: 'fake-6.1',
      buildConfiguration: '--enable-libx264 --enable-libass',
      encoders: ['libx264', 'aac', 'mjpeg'],
      filters: [
        'subtitles',
        'drawtext',
        'loudnorm',
        'sidechaincompress',
        'amix',
        'overlay',
      ],
      muxers: ['mp4'],
      demuxers: ['mov'],
      missing: [],
      smokeOk: this.capsOk,
      smokeError: null,
      ok: this.capsOk,
    };
  }

  async probe(
    jobId: string,
    attemptId: string,
    files: string[],
  ): Promise<Array<ProbeResult | null>> {
    const dir = this.attemptDir(jobId, attemptId);
    const out: Array<ProbeResult | null> = [];
    for (const f of files) {
      try {
        const buf = await fsp.readFile(path.join(dir, f));
        if (buf.toString().startsWith('notmedia')) {
          out.push(null);
          continue;
        }
        out.push({
          formatName: 'mov,mp4',
          durationSec: 1,
          bytes: buf.length,
          sha256: sha(buf.toString('latin1')),
          mime: 'video/mp4',
          streams: [
            {
              index: 0,
              type: 'video',
              codec: 'h264',
              width: 64,
              height: 64,
              fps: 25,
            },
          ],
        });
      } catch {
        out.push(null);
      }
    }
    return out;
  }
}

// ── Фейковые порты ─────────────────────────────────────────────────────

export interface FakeDownloads {
  calls: string[];
  /** Поведение по пути URL. */
  behave: (url: URL, signal?: AbortSignal) => Promise<string | Error>;
}

export function fakePorts(
  executor: FakeExecutor,
  downloads?: Partial<FakeDownloads>,
): Ports & {
  downloads: FakeDownloads;
} {
  const dl: FakeDownloads = {
    calls: [],
    behave: async (u) => `media:${u.pathname}`,
    ...downloads,
  };
  return {
    downloads: dl,
    executor,
    parseJob(body: JobRequestBody) {
      const keys = Object.keys(body.input_files);
      if (body.ffmpeg_commands.some((c) => c.includes('evil'))) {
        return {
          ok: false,
          code: 'UNSUPPORTED_COMMAND',
          message: 'unsupported option',
        };
      }
      if (body.output_files.some((o) => o.includes('/'))) {
        return {
          ok: false,
          code: 'INVALID_REQUEST',
          message: 'bad output name',
        };
      }
      const plan: ExecPlan = {
        inputs: keys.map((k) => ({
          key: k,
          url: body.input_files[k],
          localName: k,
        })),
        outputs: body.output_files.map((n) => ({ name: n, localName: n })),
        steps: body.output_files.map((n) => ({
          argv: ['-i', `inputs/${keys[0]}`, `outputs/${n}`],
        })),
        intermediates: [],
      };
      return { ok: true, plan };
    },
    checkSourceUrl(url: string, allowed: readonly string[]) {
      try {
        const u = new URL(url);
        if (u.protocol === 'https:' && allowed.includes(u.hostname))
          return { ok: true, host: u.hostname };
      } catch {
        /* ниже */
      }
      return { ok: false, code: 'FORBIDDEN_SOURCE', message: 'forbidden' };
    },
    async downloadInput(url, dest, opts) {
      dl.calls.push(url);
      const r = await dl.behave(new URL(url), opts.signal);
      if (r instanceof Error) throw r;
      await fsp.writeFile(dest, r);
      return {
        bytes: Buffer.byteLength(r),
        sha256: sha(r),
        contentType: 'video/mp4',
      };
    },
    checkInputLimits(p) {
      return p.bytes > 1_000_000
        ? { ok: false, code: 'INPUT_LIMIT_EXCEEDED', message: 'too big' }
        : { ok: true };
    },
    async verifyOutputs(attemptDir, outputs, _limits, opts) {
      const files = [];
      for (const o of outputs) {
        let buf: Buffer;
        try {
          buf = await fsp.readFile(
            path.join(attemptDir, 'outputs', o.localName),
          );
        } catch {
          return {
            ok: false,
            code: 'OUTPUT_MISSING',
            name: o.name,
            message: 'missing',
          };
        }
        const [probe] = await opts.probe([`outputs/${o.localName}`]);
        files.push({
          name: o.name,
          localName: o.localName,
          bytes: buf.length,
          sha256: createHash('sha256').update(buf).digest('hex'),
          mime: o.name.endsWith('.jpg') ? 'image/jpeg' : 'video/mp4',
          probe,
        });
      }
      return { ok: true, files };
    },
  };
}

export function codeError(code: string, message = code): Error {
  return Object.assign(new Error(message), { code });
}

// ── Приложение + HTTP ──────────────────────────────────────────────────

export interface TestApp {
  app: App;
  base: string;
  dir: string;
  executor: FakeExecutor;
  ports: ReturnType<typeof fakePorts>;
  logs: string[];
  close(): Promise<void>;
}

export async function startTestApp(
  opts: {
    dir?: string;
    env?: Record<string, string>;
    executor?: FakeExecutor;
    downloads?: Partial<FakeDownloads>;
    manual?: boolean;
    now?: () => number;
    orphanAgeMs?: number;
  } = {},
): Promise<TestApp> {
  const dir = opts.dir ?? tempDir();
  const cfg = makeConfig(dir, opts.env);
  const executor = opts.executor ?? new FakeExecutor(cfg.workspaceRoot);
  const ports = fakePorts(executor, opts.downloads);
  const { lines, log } = memoryLogger();
  const app = await createApp({
    cfg,
    ports,
    log,
    manual: opts.manual,
    now: opts.now,
    readinessCacheMs: 0,
    orphanAgeMs: opts.orphanAgeMs,
  });
  const port = await app.listen(0, '127.0.0.1');
  return {
    app,
    base: `http://127.0.0.1:${port}`,
    dir,
    executor,
    ports,
    logs: lines,
    close: () => app.close(),
  };
}

export function cleanupDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export const sampleBody = (n = 1): JobRequestBody => ({
  input_files: { base: `https://storage.test/video-${n}.mp4?sig=SECRET${n}` },
  output_files: ['poster.jpg'],
  ffmpeg_commands: ['ffmpeg -i {{base}} -frames:v 1 {{poster.jpg}}'],
});

/** Разобранный JSON ответа: в тестах — свободная навигация по полям. */
export interface ApiResult {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: any;
  headers: Headers;
  text: string;
}

export async function api(
  base: string,
  method: string,
  p: string,
  opts: {
    key?: string | null;
    body?: unknown;
    headers?: Record<string, string>;
    raw?: string;
  } = {},
): Promise<ApiResult> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  const key = opts.key === undefined ? CLIENT_KEY : opts.key;
  if (key) headers.Authorization = `Bearer ${key}`;
  let body: string | undefined;
  if (opts.raw !== undefined) body = opts.raw;
  else if (opts.body !== undefined) body = JSON.stringify(opts.body);
  if (body !== undefined) headers['Content-Type'] ??= 'application/json';
  const res = await fetch(base + p, { method, headers, body });
  const text = await res.text();
  let json: ApiResult['json'] = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, headers: res.headers, text };
}

export async function submitJob(
  t: { base: string },
  key: string,
  body: unknown = sampleBody(),
  clientKey = CLIENT_KEY,
  extraHeaders: Record<string, string> = {},
) {
  return api(t.base, 'POST', '/api/ffmpeg', {
    key: clientKey,
    body,
    headers: { 'Idempotency-Key': key, ...extraHeaders },
  });
}

export async function waitFor<T>(
  fn: () =>
    Promise<T | undefined | null | false> | T | undefined | null | false,
  timeoutMs = 10_000,
  stepMs = 20,
): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() > until) throw new Error('waitFor: timeout');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

export async function waitStatus(
  t: TestApp,
  id: string,
  statuses: string[],
  key = CLIENT_KEY,
) {
  return waitFor(async () => {
    const r = await api(t.base, 'GET', `/api/jobs/${id}`, { key });
    return statuses.includes(r.json?.data?.status) ? r : null;
  });
}
