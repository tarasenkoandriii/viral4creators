/**
 * ExecutorClient — сторона API файлового протокола с изолированным
 * executor (контейнер без сети). Использует пакет CORE (диспетчер).
 *
 * Executor сам сканирует `WORKSPACE_ROOT/<jobId>/<attemptId>/control/
 * request.json` и берёт самую старую попытку без state/done — отдельного
 * «звонка» нет. Одна попытка за раз.
 *
 * Семантика `isAlive`: true — heartbeat попытки (или глобальный heartbeat
 * executor для ещё не взятой попытки) свежее `staleMs`. false — только
 * «устарел», НЕ доказательство завершения. Доказательство — `poll()` с
 * `kind: 'done'` или `kind: 'abandoned'` (executor после рестарта убил
 * группу процессов и подтвердил её отсутствие). Повторную попытку можно
 * делать только после одного из них.
 */
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  ExecutorDone,
  ExecutorRequest,
  ExecutorState,
  ProbeResult,
} from '../contracts';
import {
  ATTEMPT_SUBDIRS,
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
import { probeFromFfprobeJson, sha256File, mimeFor } from '../probe/probe';

export type ExecutorPoll =
  /** Каталога попытки или request.json нет. */
  | { kind: 'unknown' }
  /** request.json записан, executor ещё не взял попытку. */
  | { kind: 'queued'; requestedAt: number }
  | { kind: 'running'; state: ExecutorState; cancelRequested: boolean }
  | { kind: 'done'; done: ExecutorDone; state: ExecutorState | null }
  /** Попытка прежнего процесса executor; завершение доказано. */
  | { kind: 'abandoned'; marker: AbandonedMarker; state: ExecutorState | null };

export interface AttemptPaths {
  dir: string;
  inputs: string;
  work: string;
  outputs: string;
  control: string;
}

export interface ExecutorStatus {
  heartbeat: ExecutorHeartbeat;
  fresh: boolean;
}

export class ExecutorClientError extends Error {
  constructor(
    readonly reason: 'invalid_id' | 'already_started' | 'not_found' | 'timeout',
    message: string,
  ) {
    super(message);
  }
}

export class ExecutorClient {
  private readonly root: string;
  private readonly located = new Map<string, string>();

  constructor(opts: { workspaceRoot: string }) {
    this.root = path.resolve(opts.workspaceRoot);
  }

  get workspaceRoot(): string {
    return this.root;
  }

  attemptDir(jobId: string, attemptId: string): string {
    assertId(jobId);
    assertId(attemptId);
    return path.join(this.root, jobId, attemptId);
  }

  paths(jobId: string, attemptId: string): AttemptPaths {
    const dir = this.attemptDir(jobId, attemptId);
    return {
      dir,
      inputs: path.join(dir, 'inputs'),
      work: path.join(dir, 'work'),
      outputs: path.join(dir, 'outputs'),
      control: path.join(dir, CONTROL.dir),
    };
  }

  /** Создать каталоги попытки (inputs/work/outputs/control), 0o770. */
  async prepareAttempt(
    jobId: string,
    attemptId: string,
  ): Promise<AttemptPaths> {
    const p = this.paths(jobId, attemptId);
    for (const sub of ATTEMPT_SUBDIRS) {
      await fsp.mkdir(path.join(p.dir, sub), { recursive: true, mode: 0o770 });
    }
    this.located.set(attemptId, p.dir);
    return p;
  }

  /**
   * Отдать попытку executor: атомарно пишет control/request.json.
   * Каталоги создаются, если их нет. Повторный start той же попытки —
   * ошибка `already_started` (не перезаписываем принятую попытку).
   */
  async start(req: ExecutorRequest): Promise<void> {
    const p = await this.prepareAttempt(req.jobId, req.attemptId);
    const file = path.join(p.control, CONTROL.request);
    if (await exists(file)) {
      throw new ExecutorClientError(
        'already_started',
        `attempt ${req.attemptId} already has a request`,
      );
    }
    await writeJsonAtomic(file, req);
  }

  async poll(attemptId: string): Promise<ExecutorPoll> {
    const dir = await this.locate(attemptId);
    if (!dir) return { kind: 'unknown' };
    const reqFile = controlPath(dir, CONTROL.request);
    let requestedAt: number;
    try {
      requestedAt = (await fsp.stat(reqFile)).mtimeMs;
    } catch {
      return { kind: 'unknown' };
    }
    const state = await readJson<ExecutorState>(
      controlPath(dir, CONTROL.state),
    );
    const done = await readJson<ExecutorDone>(controlPath(dir, CONTROL.done));
    if (done && done.attemptId === attemptId) {
      return { kind: 'done', done, state };
    }
    const marker = await readJson<AbandonedMarker>(
      controlPath(dir, CONTROL.abandoned),
    );
    if (marker && marker.attemptId === attemptId) {
      return { kind: 'abandoned', marker, state };
    }
    if (state && state.attemptId === attemptId) {
      return {
        kind: 'running',
        state,
        cancelRequested: await exists(controlPath(dir, CONTROL.cancel)),
      };
    }
    return { kind: 'queued', requestedAt };
  }

  /** Идемпотентная отмена: файл control/cancel. Неизвестная попытка — no-op. */
  async cancel(attemptId: string): Promise<void> {
    const dir = await this.locate(attemptId);
    if (!dir) return;
    const file = controlPath(dir, CONTROL.cancel);
    try {
      await fsp.writeFile(file, String(Date.now()), {
        flag: 'wx',
        mode: 0o660,
      });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  }

  /**
   * true — heartbeat свежий (см. шапку файла). Для взятой попытки —
   * state.heartbeatAt; для ожидающей — глобальный heartbeat executor.
   * Завершённая/брошенная попытка — false.
   */
  async isAlive(attemptId: string, staleMs: number): Promise<boolean> {
    const st = await this.poll(attemptId);
    const now = Date.now();
    if (st.kind === 'running') return now - st.state.heartbeatAt <= staleMs;
    if (st.kind === 'queued') {
      const ex = await this.executorStatus(staleMs);
      return !!ex?.fresh;
    }
    return false;
  }

  /** Глобальный heartbeat executor (пишется и в простое). null — нет файла. */
  async executorStatus(staleMs: number): Promise<ExecutorStatus | null> {
    const hb = await readJson<ExecutorHeartbeat>(
      path.join(executorDir(this.root), HEARTBEAT_FILE),
    );
    if (!hb) return null;
    return { heartbeat: hb, fresh: Date.now() - hb.heartbeatAt <= staleMs };
  }

  /** Итог capability self-test executor; null — ещё не выполнен. */
  async capabilities(): Promise<ExecutorCapabilities | null> {
    return readJson<ExecutorCapabilities>(
      path.join(executorDir(this.root), CAPABILITIES_FILE),
    );
  }

  /**
   * ffprobe внутри изолированного executor (без сети): разбор недоверенных
   * медиа не выполняется в контейнере API. `files` — пути относительно
   * каталога попытки (`inputs/x`, `outputs/x`). sha256/bytes считаются
   * здесь (чтение байтов, без разбора). Ошибка ffprobe по файлу → null в
   * массиве. Таймаут ожидания → ExecutorClientError('timeout').
   */
  async probe(
    jobId: string,
    attemptId: string,
    files: string[],
    opts: { timeoutMs?: number; pollMs?: number; signal?: AbortSignal } = {},
  ): Promise<Array<ProbeResult | null>> {
    const p = await this.prepareAttempt(jobId, attemptId);
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const requestId = randomUUID();
    const req: ProbeRequest = { version: 1, requestId, files, timeoutMs };
    await fsp.rm(path.join(p.control, CONTROL.probeResult), { force: true });
    await writeJsonAtomic(path.join(p.control, CONTROL.probeRequest), req);
    const deadline = Date.now() + timeoutMs + 5_000;
    const pollMs = opts.pollMs ?? 100;
    for (;;) {
      if (opts.signal?.aborted)
        throw opts.signal.reason ?? new Error('aborted');
      const res = await readJson<ProbeResponse>(
        path.join(p.control, CONTROL.probeResult),
      );
      if (res && res.requestId === requestId) {
        const out: Array<ProbeResult | null> = [];
        for (const r of res.results) {
          if (!r.ok) {
            out.push(null);
            continue;
          }
          const abs = path.join(p.dir, r.file);
          const { bytes, sha256 } = await sha256File(abs);
          out.push(
            probeFromFfprobeJson(r.json, {
              bytes,
              sha256,
              mime: mimeFor(r.file, r.json),
            }),
          );
        }
        return out;
      }
      if (Date.now() > deadline) {
        throw new ExecutorClientError('timeout', 'executor probe timed out');
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  /** Найти каталог попытки по attemptId (кеш, затем скан `<root>/*`). */
  private async locate(attemptId: string): Promise<string | null> {
    if (!ID_PATTERN.test(attemptId)) return null;
    const cached = this.located.get(attemptId);
    if (cached && (await exists(cached))) return cached;
    let jobs: string[];
    try {
      jobs = await fsp.readdir(this.root);
    } catch {
      return null;
    }
    for (const job of jobs) {
      if (!ID_PATTERN.test(job)) continue;
      const dir = path.join(this.root, job, attemptId);
      if (await exists(dir)) {
        this.located.set(attemptId, dir);
        return dir;
      }
    }
    return null;
  }
}

function assertId(id: string): void {
  if (!ID_PATTERN.test(id)) {
    throw new ExecutorClientError('invalid_id', 'invalid job/attempt id');
  }
}
