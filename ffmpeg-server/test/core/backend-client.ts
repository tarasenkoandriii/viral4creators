/**
 * Загрузка НАСТОЯЩЕГО backend-клиента `FfmpegApiService`
 * (backend/src/modules/postprod/ffmpeg-api.service.ts) для сквозного
 * теста без зависимостей backend.
 *
 * Решение (Р-FF-CORE-6): файл читается как есть и транспилируется
 * TypeScript (`transpileModule`, без проверки типов — её делает CI
 * backend); подменяются только фреймворк-импорты: `@nestjs/common`
 * (Injectable/Optional — no-op, Logger — тихий) и PrismaService (класс-
 * заглушка, сам prisma передаётся объектом в конструктор). Так тест
 * гоняет ровно тот HTTP-контракт, который отправляет backend, и не
 * требует backend/node_modules в джобе ffmpeg-server. Любой новый
 * не-фреймворковый импорт сервиса роняет тест явно — его надо добавить
 * в заглушки осознанно.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

export const BACKEND_SERVICE = path.resolve(
  __dirname,
  '../../../backend/src/modules/postprod/ffmpeg-api.service.ts',
);

const noopDecorator = () => () => undefined;

class QuietLogger {
  constructor(readonly name?: string) {}
  log(): void {}
  warn(): void {}
  error(): void {}
  debug(): void {}
}

const STUBS: Record<string, unknown> = {
  '@nestjs/common': {
    Injectable: noopDecorator,
    Optional: noopDecorator,
    Inject: noopDecorator,
    Logger: QuietLogger,
  },
  '../../prisma/prisma.service': { PrismaService: class PrismaService {} },
};

export interface BackendFfmpegService {
  submit(opts: {
    inputs: Record<string, string>;
    outputs: string[];
    commands: string[];
    retrySubmit?: boolean;
    product?: string;
    operationKey?: string;
  }): Promise<{ jobId: string; status: string; provider?: string }>;
  status(
    jobId: string,
    timeoutMs?: number,
    opts?: { retry?: boolean },
  ): Promise<{
    status: 'pending' | 'completed' | 'failed';
    outputs?: Record<string, string>;
    error?: string;
    errorCode?: string;
  }>;
}

export const BACKEND_OPS_CLIENT = path.resolve(
  __dirname,
  '../../../backend/src/modules/ffmpeg-admin/ffmpeg-ops.client.ts',
);

/** Транспилировать backend-файл как есть и вернуть его exports. */
export function loadBackendModule(file: string): Record<string, unknown> {
  const source = readFileSync(file, 'utf8');
  const out = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      experimentalDecorators: true,
      emitDecoratorMetadata: false,
      esModuleInterop: true,
    },
    fileName: file,
  }).outputText;
  const mod: { exports: Record<string, unknown> } = { exports: {} };
  const req = (id: string): unknown => {
    if (id in STUBS) return STUBS[id];
    if (id.startsWith('node:') || ['crypto', 'path', 'util'].includes(id)) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      return require(id);
    }
    throw new Error(
      `${path.basename(file)}: неожиданный импорт ${id} — добавьте заглушку осознанно`,
    );
  };
  new Function('require', 'module', 'exports', out)(req, mod, mod.exports);
  return mod.exports;
}

export function loadBackendFfmpegService(
  prisma?: unknown,
): BackendFfmpegService {
  const Ctor = loadBackendModule(BACKEND_SERVICE).FfmpegApiService as new (
    prisma?: unknown,
  ) => BackendFfmpegService;
  return new Ctor(prisma);
}

export interface BackendOpsClient {
  request(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    opts: {
      role: 'ops' | 'client';
      body?: unknown;
      idempotencyKey?: string;
      correlationId?: string;
      query?: Record<string, string | undefined>;
    },
  ): Promise<Record<string, unknown>>;
  requestWithStatus(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    opts: Parameters<BackendOpsClient['request']>[2],
  ): Promise<{ status: number; data: Record<string, unknown> }>;
}

/** Настоящий FfmpegOpsClient вкладки «FFmpeg» и его классы ошибок. */
export function loadBackendOpsClient(): {
  client: BackendOpsClient;
  Rejected: new (...a: never[]) => Error;
  Unavailable: new (...a: never[]) => Error;
  sanitizeOps: (v: unknown) => unknown;
} {
  const m = loadBackendModule(BACKEND_OPS_CLIENT);
  const Ctor = m.FfmpegOpsClient as new () => BackendOpsClient;
  return {
    client: new Ctor(),
    Rejected: m.FfmpegOpsRejected as new (...a: never[]) => Error,
    Unavailable: m.FfmpegOpsUnavailable as new (...a: never[]) => Error,
    sanitizeOps: m.sanitizeOps as (v: unknown) => unknown,
  };
}
