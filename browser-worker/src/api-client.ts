/**
 * Клиент внутреннего API sites-backend для воркера (Э-С Ш3). Каждый запрос
 * подписан HMAC (`shared/sites-internal-signature.ts` — тот же код, что
 * проверяет сервер): метод, путь, тело, метка времени, случайный id;
 * вызывающий — `browser-worker`. Секрет по сети не ходит. Воркер — только
 * клиент: входящих портов у него нет.
 */
import { randomUUID } from 'crypto';
import {
  WORKER_CALLER,
  WORKER_ROUTES,
  type BrowserJobKind,
  type ClaimedJob,
  type WorkerErrorCode,
} from './shared/browser-job-protocol';
import { sitesSignatureHeaders } from './shared/sites-internal-signature';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`sites-backend ${status} ${code}`);
    this.name = 'ApiError';
  }
}

export interface WorkerApi {
  claim(
    kinds: BrowserJobKind[],
    max: number,
  ): Promise<{ enabled: boolean; jobs: ClaimedJob[] }>;
  heartbeat(jobId: string, leaseToken: string): Promise<{ cancel: boolean }>;
  complete(jobId: string, leaseToken: string, result: unknown): Promise<void>;
  fail(
    jobId: string,
    leaseToken: string,
    code: WorkerErrorCode,
  ): Promise<{ retry: boolean }>;
  credentials(
    jobId: string,
    leaseToken: string,
  ): Promise<{ sealed: string; attempt: number }>;
  artifact(
    jobId: string,
    leaseToken: string,
    a: {
      idx: number;
      contentType: string;
      width: number | null;
      height: number | null;
      data: Buffer;
    },
  ): Promise<void>;
}

export interface ApiClientOptions {
  baseUrl: string;
  secret: string;
  workerId: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}

export function createApiClient(o: ApiClientOptions): WorkerApi {
  const f = o.fetchImpl ?? fetch;
  const call = async <T>(
    path: string,
    body: unknown,
    timeoutMs = o.timeoutMs ?? 20_000,
  ): Promise<T> => {
    const raw = JSON.stringify(body);
    const headers = sitesSignatureHeaders(o.secret, {
      caller: WORKER_CALLER,
      method: 'POST',
      path,
      body: raw,
      unixSeconds: Math.floor((o.now?.() ?? Date.now()) / 1000),
      requestId: randomUUID(),
    });
    const res = await f(`${o.baseUrl}${path}`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: raw,
      // Аудит Ш3: редирект не исполняется — иначе `fetch` переотправил бы
      // ещё не использованный подписанный запрос (тело с токенами аренды и
      // результатом) на чужой адрес, откуда его можно повторить на сервер.
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    const env = (json ?? {}) as {
      success?: boolean;
      data?: unknown;
      error?: { code?: string };
    };
    if (!res.ok || env.success !== true) {
      throw new ApiError(res.status, String(env.error?.code ?? 'HTTP_ERROR'));
    }
    return env.data as T;
  };
  return {
    claim: (kinds, max) =>
      call(WORKER_ROUTES.claim, { workerId: o.workerId, kinds, max }),
    heartbeat: (jobId, leaseToken) =>
      call(WORKER_ROUTES.heartbeat, { jobId, leaseToken }),
    complete: async (jobId, leaseToken, result) => {
      await call(WORKER_ROUTES.complete, { jobId, leaseToken, result }, 60_000);
    },
    fail: (jobId, leaseToken, code) =>
      call(WORKER_ROUTES.fail, { jobId, leaseToken, code }),
    credentials: (jobId, leaseToken) =>
      call(WORKER_ROUTES.credentials, { jobId, leaseToken }),
    artifact: async (jobId, leaseToken, a) => {
      await call(
        WORKER_ROUTES.artifact,
        {
          jobId,
          leaseToken,
          idx: a.idx,
          contentType: a.contentType,
          width: a.width,
          height: a.height,
          data: a.data.toString('base64'),
        },
        60_000,
      );
    },
  };
}
