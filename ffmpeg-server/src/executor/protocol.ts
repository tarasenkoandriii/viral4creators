/**
 * Файловый протокол API ↔ executor — дополнения пакета EXEC к
 * `src/contracts.ts` (тот файл не меняется). Здесь — пути внутри
 * workspace, служебные файлы executor и атомарная запись JSON.
 *
 * Раскладка:
 *   <WORKSPACE_ROOT>/.executor/heartbeat.json    — глобальный heartbeat executor
 *   <WORKSPACE_ROOT>/.executor/capabilities.json — итог capability self-test
 *   <WORKSPACE_ROOT>/<jobId>/<attemptId>/{inputs,work,outputs,control}/
 *   control/request.json   — пишет API (ExecutorRequest), атомарно
 *   control/cancel         — пишет API при отмене
 *   control/state.json     — пишет executor (ExecutorState, heartbeat)
 *   control/done.json      — пишет executor (ExecutorDone), атомарно, финал
 *   control/abandoned.json — пишет executor при старте, если нашёл попытку
 *                            прежнего процесса без done.json и ДОКАЗАЛ, что
 *                            её группа процессов мертва (см. AbandonedMarker)
 *   control/probe-request.json / probe-result.json — ffprobe внутри
 *                            изолированного executor (ProbeRequest/Result)
 */
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

export const EXECUTOR_DIR = '.executor';
export const HEARTBEAT_FILE = 'heartbeat.json';
export const CAPABILITIES_FILE = 'capabilities.json';

export const CONTROL = {
  dir: 'control',
  request: 'request.json',
  cancel: 'cancel',
  state: 'state.json',
  done: 'done.json',
  abandoned: 'abandoned.json',
  probeRequest: 'probe-request.json',
  probeResult: 'probe-result.json',
} as const;

export const ATTEMPT_SUBDIRS = [
  'inputs',
  'work',
  'outputs',
  'control',
] as const;

/** Допустимый id job/attempt — один сегмент пути без точек в начале. */
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** Глобальный heartbeat executor (пишется и в простое). */
export interface ExecutorHeartbeat {
  version: 1;
  pid: number;
  startedAt: number;
  heartbeatAt: number;
  /** Попытка, которую executor выполняет сейчас; null — простой. */
  busyAttemptId: string | null;
  ffmpegVersion: string | null;
}

/** Итог capability self-test при старте executor. */
export interface ExecutorCapabilities {
  version: 1;
  checkedAt: number;
  ffmpegVersion: string | null;
  ffprobeVersion: string | null;
  /** Строка `configuration:` из `ffmpeg -version` (build flags). */
  buildConfiguration: string | null;
  encoders: string[];
  filters: string[];
  muxers: string[];
  demuxers: string[];
  /** Требуемые корпусом компоненты, которых нет в сборке. */
  missing: string[];
  /** Рендер смоук-теста (libx264+aac+libass с кириллицей) прошёл. */
  smokeOk: boolean;
  smokeError: string | null;
  ok: boolean;
}

/**
 * Попытка прежнего процесса executor, найденная при старте без done.json.
 * Executor убил её группу (`kill(-pgid)`) и подтвердил, что процессов
 * группы нет. Только этот маркер (или done.json) — доказательство
 * завершения; устаревший heartbeat им не является.
 */
export interface AbandonedMarker {
  version: 1;
  attemptId: string;
  pgid: number | null;
  /** Группа была жива и её пришлось убить. */
  killed: boolean;
  confirmedAt: number;
}

export interface ProbeRequest {
  version: 1;
  /** Уникальный id запроса — результат сопоставляется по нему. */
  requestId: string;
  /** Пути относительно каталога попытки (`inputs/x`, `outputs/x`). */
  files: string[];
  timeoutMs: number;
}

export interface ProbeFileResult {
  file: string;
  ok: boolean;
  /** Сырой JSON ffprobe (`-show_format -show_streams`), если ok. */
  json: unknown;
  error: string | null;
}

export interface ProbeResponse {
  version: 1;
  requestId: string;
  results: ProbeFileResult[];
  finishedAt: number;
}

export function executorDir(root: string): string {
  return path.join(root, EXECUTOR_DIR);
}

export function controlPath(attemptDir: string, file: string): string {
  return path.join(attemptDir, CONTROL.dir, file);
}

/** Атомарная запись JSON: tmp в том же каталоге + fsync + rename. */
export async function writeJsonAtomic(
  file: string,
  value: unknown,
): Promise<void> {
  const dir = path.dirname(file);
  const tmp = path.join(
    dir,
    `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  );
  const fh = await fsp.open(tmp, 'wx', 0o660);
  try {
    await fh.writeFile(JSON.stringify(value));
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await fsp.rename(tmp, file);
  } catch (e) {
    await fsp.rm(tmp, { force: true });
    throw e;
  }
}

/** Прочитать JSON; отсутствующий файл → null; битый → null. */
export async function readJson<T>(file: string): Promise<T | null> {
  let raw: string;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function exists(file: string): Promise<boolean> {
  try {
    await fsp.access(file);
    return true;
  } catch {
    return false;
  }
}
