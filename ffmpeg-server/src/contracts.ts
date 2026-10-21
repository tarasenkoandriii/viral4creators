/**
 * Внутренние контракты между частями ffmpeg-server (ТЗ
 * docs-tz/FFmpeg-server-spec-v1.1-RU.md). Владелец файла — главный агент;
 * пакеты CORE (api/db/queue/files/cleanup/control) и EXEC
 * (command/download/executor/probe) реализуют стороны этих интерфейсов.
 * Менять — только согласованно.
 */

/** Тело POST /api/ffmpeg после JSON-валидации формы (до разбора команд). */
export interface JobRequestBody {
  input_files: Record<string, string>;
  output_files: string[];
  ffmpeg_commands: string[];
}

/** Стабильные коды ошибок (ТЗ §5.2–5.3). Публичны: уходят клиенту. */
export type ErrorCode =
  | 'INVALID_REQUEST'
  | 'UNSUPPORTED_COMMAND'
  | 'FORBIDDEN_SOURCE'
  | 'INPUT_DOWNLOAD_FAILED'
  | 'INPUT_EXPIRED'
  | 'INPUT_TOO_LARGE'
  | 'INPUT_INVALID_MEDIA'
  | 'INPUT_LIMIT_EXCEEDED'
  | 'COMMAND_FAILED'
  | 'OUTPUT_MISSING'
  | 'OUTPUT_TOO_LARGE'
  | 'OUTPUT_INVALID_MEDIA'
  | 'TIMEOUT'
  | 'QUEUE_TIMEOUT'
  | 'OOM'
  | 'CANCELED'
  | 'INTERRUPTED'
  | 'OUTPUT_EXPIRED'
  | 'OUTPUT_PURGED'
  | 'INTERNAL';

/** Профиль лимитов (ТЗ §9). Эффективные значения ≤ верхних границ деплоя. */
export interface LimitsProfile {
  revision: number;
  maxInputs: number;
  maxCommands: number;
  maxOutputs: number;
  maxCommandsTextBytes: number;
  maxInputBytes: number;
  maxTotalInputBytes: number;
  maxTotalOutputBytes: number;
  maxWorkspaceBytes: number;
  maxWidth: number;
  maxHeight: number;
  maxFps: number;
  maxInputDurationSec: number;
  maxImagePixels: number;
  pipelineDeadlineSec: number;
  queueDeadlineSec: number;
  downloadFileDeadlineSec: number;
  downloadConnectTimeoutSec: number;
  downloadStallTimeoutSec: number;
  maxThreads: number;
  stderrTailBytes: number;
}

/** Результат разбора одной задачи (command/parse.ts). */
export interface ExecPlan {
  /** Входы: ключ клиента → URL и локальное имя внутри workspace/inputs. */
  inputs: Array<{ key: string; url: string; localName: string }>;
  /** Объявленные финальные результаты: имя клиента → локальное имя в outputs/. */
  outputs: Array<{ name: string; localName: string }>;
  /** Шаги: argv БЕЗ бинарника (`ffmpeg` добавляет executor), пути относительны workspace. */
  steps: Array<{ argv: string[] }>;
  /** Промежуточные файлы, которые шаги создают и читают (внутри workspace/work). */
  intermediates: string[];
}

export type ParseResult =
  | { ok: true; plan: ExecPlan }
  | {
      ok: false;
      code: 'INVALID_REQUEST' | 'UNSUPPORTED_COMMAND';
      message: string;
    };

/** Ошибка скачивания (download/download.ts). */
export interface DownloadOutcome {
  bytes: number;
  sha256: string;
  contentType: string | null;
}

/** Метаданные медиа (probe/probe.ts) — также идут в outputs_metadata. */
export interface ProbeStream {
  index: number;
  type: 'video' | 'audio' | 'subtitle' | 'data' | 'attachment' | 'unknown';
  codec: string | null;
  width?: number;
  height?: number;
  fps?: number;
  sampleRate?: number;
  channels?: number;
  durationSec?: number | null;
  rotation?: number;
}
export interface ProbeResult {
  formatName: string | null;
  durationSec: number | null;
  bytes: number;
  sha256: string;
  mime: string;
  streams: ProbeStream[];
}

/**
 * Файловый протокол API ↔ executor (контейнер без сети).
 * Каталог попытки: `<WORKSPACE_ROOT>/<jobId>/<attemptId>/`, внутри:
 *   inputs/ (пишет API), work/, outputs/ (пишет ffmpeg), control/.
 * API пишет `control/request.json` (атомарно: tmp + rename), при отмене —
 * `control/cancel`. Executor пишет `control/state.json` (heartbeat) и
 * финальный `control/done.json`. Executor обслуживает одну попытку за раз.
 */
export interface ExecutorRequest {
  version: 1;
  jobId: string;
  attemptId: string;
  steps: Array<{ argv: string[] }>;
  /** Абсолютный срок (epoch ms), после которого executor убивает группу процессов. */
  deadlineAt: number;
  maxThreads: number;
  stderrTailBytes: number;
  /** Лимит суммарного размера файлов, создаваемых ffmpeg в work/ и outputs/. */
  maxWriteBytes: number;
}
export interface ExecutorState {
  version: 1;
  attemptId: string;
  status: 'running' | 'exited';
  pid: number | null;
  startedAt: number;
  heartbeatAt: number;
  stepIndex: number;
  /** Секунды медиа, обработанные текущим шагом (из -progress), для прогресса. */
  outTimeSec: number | null;
}
export interface ExecutorDone {
  version: 1;
  attemptId: string;
  outcome:
    'succeeded' | 'failed' | 'canceled' | 'timeout' | 'oom' | 'too_large';
  failedStep: number | null;
  exitCode: number | null;
  signal: string | null;
  /** Очищенный хвост stderr (без путей вне workspace), ≤ stderrTailBytes. */
  stderrTail: string;
  wallMs: number;
  cpuMs: number | null;
  peakRssKb: number | null;
  ffmpegVersion: string | null;
  finishedAt: number;
}
