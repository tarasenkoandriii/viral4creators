/**
 * Узкие интерфейсы к модулям пакета EXEC (command/download/probe/executor).
 * Диспетчер и API зависят только от них: в тестах — фейки, в main.ts —
 * реальные реализации (queue/adapters.ts).
 */
import type {
  DownloadOutcome,
  ErrorCode,
  ExecPlan,
  ExecutorRequest,
  JobRequestBody,
  LimitsProfile,
  ParseResult,
  ProbeResult,
} from '../contracts';
import type {
  AttemptPaths,
  ExecutorPoll,
  ExecutorStatus,
} from '../executor/client';
import type { ExecutorCapabilities } from '../executor/protocol';

export type {
  AttemptPaths,
  ExecutorPoll,
  ExecutorStatus,
  ExecutorCapabilities,
};

export type SourceCheck =
  | { ok: true; host: string }
  | { ok: false; code: 'FORBIDDEN_SOURCE'; message: string };

export interface DownloadOpts {
  allowedHosts: readonly string[];
  /** Порты источников (по умолчанию 443; иные — только тесты). */
  allowedPorts?: readonly number[];
  maxBytes: number;
  deadlineAt?: number;
  connectTimeoutMs?: number;
  stallTimeoutMs?: number;
  fileTimeoutMs?: number;
  signal?: AbortSignal;
}

export type InputLimitsCheck =
  | { ok: true }
  | {
      ok: false;
      code: 'INPUT_LIMIT_EXCEEDED' | 'INPUT_INVALID_MEDIA';
      message: string;
    };

export interface VerifiedOutput {
  name: string;
  localName: string;
  bytes: number;
  sha256: string;
  mime: string;
  probe: ProbeResult | null;
}

export type OutputsCheck =
  | { ok: true; files: VerifiedOutput[] }
  | {
      ok: false;
      code: 'OUTPUT_MISSING' | 'OUTPUT_TOO_LARGE' | 'OUTPUT_INVALID_MEDIA';
      name: string;
      message: string;
    };

/** Сторона API файлового протокола (структурно = ExecutorClient EXEC). */
export interface ExecutorPort {
  prepareAttempt(jobId: string, attemptId: string): Promise<AttemptPaths>;
  attemptDir(jobId: string, attemptId: string): string;
  start(req: ExecutorRequest): Promise<void>;
  poll(attemptId: string): Promise<ExecutorPoll>;
  cancel(attemptId: string): Promise<void>;
  isAlive(attemptId: string, staleMs: number): Promise<boolean>;
  executorStatus(staleMs: number): Promise<ExecutorStatus | null>;
  capabilities(): Promise<ExecutorCapabilities | null>;
  probe(
    jobId: string,
    attemptId: string,
    files: string[],
    opts?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<Array<ProbeResult | null>>;
}

export interface Ports {
  parseJob(body: JobRequestBody, limits: LimitsProfile): ParseResult;
  checkSourceUrl(
    url: string,
    allowedHosts: readonly string[],
    opts?: { allowedPorts?: readonly number[] },
  ): SourceCheck;
  /** Бросает ошибку с полем `code: ErrorCode`. */
  downloadInput(
    url: string,
    destPath: string,
    opts: DownloadOpts,
  ): Promise<DownloadOutcome>;
  checkInputLimits(probe: ProbeResult, limits: LimitsProfile): InputLimitsCheck;
  verifyOutputs(
    attemptDir: string,
    outputs: ExecPlan['outputs'],
    limits: LimitsProfile,
    opts: {
      probe: (relPaths: string[]) => Promise<Array<ProbeResult | null>>;
    },
  ): Promise<OutputsCheck>;
  executor: ExecutorPort;
}

/** Код ошибки из исключения порта; неизвестное → INTERNAL. */
export function errorCodeOf(
  e: unknown,
  fallback: ErrorCode = 'INTERNAL',
): ErrorCode {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' && KNOWN.has(code as ErrorCode)
    ? (code as ErrorCode)
    : fallback;
}

const KNOWN = new Set<ErrorCode>([
  'INVALID_REQUEST',
  'UNSUPPORTED_COMMAND',
  'FORBIDDEN_SOURCE',
  'INPUT_DOWNLOAD_FAILED',
  'INPUT_EXPIRED',
  'INPUT_TOO_LARGE',
  'INPUT_INVALID_MEDIA',
  'INPUT_LIMIT_EXCEEDED',
  'COMMAND_FAILED',
  'OUTPUT_MISSING',
  'OUTPUT_TOO_LARGE',
  'OUTPUT_INVALID_MEDIA',
  'TIMEOUT',
  'QUEUE_TIMEOUT',
  'OOM',
  'CANCELED',
  'INTERRUPTED',
  'OUTPUT_EXPIRED',
  'OUTPUT_PURGED',
  'INTERNAL',
]);
