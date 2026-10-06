/**
 * Исполнение изменяющей операции коннектора после «Да» (ТЗ §5.5, §5.7;
 * приёмка Э8 п.3). Те же слои SSRF-guard, что у `read` (connector-exec.ts):
 * URL собирает код по схеме, хост — только из `allowedHosts`, сеть —
 * `pinnedFetch` (https:443, IP-pin, блок частных адресов, БЕЗ редиректов,
 * 10 с, ответ ≤ 1 МБ). Отличия от `read`:
 *  - НИКАКОГО автоповтора: 5xx/таймаут/обрыв — `unknown` (могло примениться);
 *    повтор — только новым «Да» с тем же `Idempotency-Key`;
 *  - заголовки: `Idempotency-Key` = id предложения, `X-V4C-Actor`,
 *    `X-V4C-Signature` (если владелец выпустил секрет подписи), секрет
 *    коннектора — только в заголовке;
 *  - 4xx — `failed` с текстом ошибки API (усечён, маскирован, секрет
 *    вырезан); 401 с признаком отказа по КЛЮЧУ коннектора
 *    (`authRejection`) — `auth_failed`; 401 без признака — `failed` с
 *    `authReject: 'unclear'` (пауза — решает сервис по отказам разным
 *    сотрудникам); 403 — обычный `failed`: отказ по сотруднику, коннектор
 *    исправен (аудит Н-3); 3xx — `unknown` (POST мог исполниться до
 *    редиректа, по которому мы не идём).
 */
import { BodyTooLargeError } from '../../shared/external-url-guard';
import {
  type AuthRejection,
  type ConnectorAuth,
  EXEC_MAX_BYTES,
  EXEC_MODEL_DATA_BYTES,
  EXEC_TIMEOUT_MS,
  ParamValidationError,
  authHeaders,
  authRejection,
  buildUrl,
  hostAllowed,
  maskedRequest,
  scrubSecret,
  validateArgs,
} from '../assist-admin-mode/connector-exec';
import type { OperationParam } from '../assist-admin-mode/openapi-import';
import {
  FetchTimeoutError,
  type PinnedHttpDeps,
  RedirectOffsiteError,
  SsrfBlockedError,
  pinnedFetch,
} from '../site-crawl/net/pinned-fetch';
import {
  IDEMPOTENCY_HEADER,
  SIGNATURE_HEADER,
  apiErrorText,
  signRequest,
} from './action-core';

export type WriteOutcome =
  | 'ok'
  | 'http_error'
  | 'auth_failed'
  | 'timeout'
  | 'blocked'
  | 'invalid_params'
  | 'unknown';

export interface WriteRequest {
  baseUrl: string;
  allowedHosts: readonly string[];
  method: string;
  path: string;
  params: readonly OperationParam[];
  args: Record<string, unknown>;
  auth: ConnectorAuth;
  actor: string;
  idempotencyKey: string;
  /** Секрет подписи коннектора (`X-V4C-Signature`) или null. */
  signSecret: string | null;
  nowSec: number;
  /** Таймаут запроса (по умолчанию 10 с, §5.5); тесты — меньше. */
  timeoutMs?: number;
}

export interface WriteResult {
  outcome: WriteOutcome;
  /** done | failed | unknown — итог для предложения. */
  status: 'done' | 'failed' | 'unknown';
  httpStatus: number | null;
  durationMs: number;
  requestMasked: {
    method: string;
    path: string;
    query: Record<string, string>;
    body?: Record<string, unknown>;
  };
  responseBytes: number | null;
  /** Текст ошибки API для карточки (4xx) — без секрета и ПД. */
  errorText: string | null;
  error: string | null;
  /** Тело ответа 2xx (JSON-текст, секрет вырезан, усечён) — для `native`. */
  data: string | null;
  /** 401: отказ по ключу коннектора или неясный (аудит Н-3). */
  authReject?: AuthRejection;
}

/** Маска тела для журнала: строки — `mask`, числа и флаги — как есть. */
export function maskBody(
  body: Record<string, unknown> | null,
  mask: (s: string) => string,
): Record<string, unknown> | undefined {
  if (!body) return undefined;
  const one = (v: unknown): unknown =>
    typeof v === 'string' ? mask(v) : Array.isArray(v) ? v.map(one) : v;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) out[k] = one(v);
  return out;
}

const ALLOWED_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Значение заголовка `X-V4C-Actor`: `sub` сотрудника может быть кириллицей
 * (identity-jwt пускает `\p{L}`), а HTTP-клиент такой заголовок не
 * отправляет — бросает ДО сети, и «Да» ложно становилось `unknown`
 * (аудит Э8). Всё вне печатного ASCII — percent-encoding (UTF-8), как в URL.
 */
export function actorHeaderValue(actor: string): string {
  return Array.from(actor)
    .slice(0, 128)
    .join('')
    .replace(/[^\x21-\x7e]|%/gu, (c) => {
      if (c === '%') return '%25';
      try {
        return encodeURIComponent(c);
      } catch {
        return '%EF%BF%BD'; // одиночный суррогат
      }
    });
}

export async function executeWrite(
  req: WriteRequest,
  deps: Partial<PinnedHttpDeps> | undefined,
  mask: (s: string) => string,
): Promise<WriteResult> {
  const started = Date.now();
  const method = req.method.toUpperCase();
  const base = {
    httpStatus: null,
    responseBytes: null,
    errorText: null,
    data: null,
  };
  const fail = (
    outcome: WriteOutcome,
    status: WriteResult['status'],
    error: string,
    requestMasked: WriteResult['requestMasked'],
    extra: Partial<WriteResult> = {},
  ): WriteResult => ({
    ...base,
    outcome,
    status,
    error,
    requestMasked,
    durationMs: Date.now() - started,
    ...extra,
  });
  if (!ALLOWED_METHODS.has(method)) {
    return fail('blocked', 'failed', 'method', {
      method,
      path: req.path,
      query: {},
    });
  }
  let parts;
  try {
    parts = validateArgs(req.params, req.args);
  } catch (e) {
    return fail(
      'invalid_params',
      'failed',
      e instanceof ParamValidationError ? e.detail.slice(0, 200) : 'invalid',
      { method, path: req.path, query: {} },
    );
  }
  const requestMasked: WriteResult['requestMasked'] = {
    ...maskedRequest(method, req.path, parts.path, parts.query, mask),
    ...(parts.body ? { body: maskBody(parts.body, mask) } : {}),
  };
  let url: URL;
  try {
    url = buildUrl(req.baseUrl, req.path, parts.path, parts.query);
  } catch {
    return fail('invalid_params', 'failed', 'url', requestMasked);
  }
  if (!hostAllowed(url, req.allowedHosts)) {
    return fail('blocked', 'failed', 'host_not_allowed', requestMasked);
  }
  const body =
    parts.body && Object.keys(parts.body).length
      ? JSON.stringify(parts.body)
      : parts.body && method !== 'DELETE'
        ? '{}'
        : undefined;
  const headers: Record<string, string> = {
    accept: 'application/json',
    'x-v4c-actor': actorHeaderValue(req.actor),
    [IDEMPOTENCY_HEADER]: req.idempotencyKey,
    ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    ...authHeaders(req.auth),
  };
  if (req.signSecret) {
    headers[SIGNATURE_HEADER] = signRequest(
      req.signSecret,
      method,
      req.idempotencyKey,
      `${url.pathname}${url.search}`,
      body ?? '',
      req.nowSec,
    );
  }
  let res;
  try {
    res = await pinnedFetch(
      url.href,
      {
        method: method as 'POST' | 'PUT' | 'PATCH' | 'DELETE',
        headers,
        ...(body !== undefined ? { body } : {}),
        maxBytes: EXEC_MAX_BYTES,
        timeoutMs: req.timeoutMs ?? EXEC_TIMEOUT_MS,
        maxRedirects: 0,
        sameOrigin: true,
      },
      deps,
    );
  } catch (e) {
    // До отправки (адрес не прошёл SSRF-guard) — точно не исполнено.
    if (e instanceof SsrfBlockedError || e instanceof RedirectOffsiteError) {
      return fail('blocked', 'failed', 'ssrf', requestMasked);
    }
    // Таймаут, обрыв, слишком большой ответ: запрос мог дойти — `unknown`,
    // без автоповтора (§5.7).
    if (e instanceof FetchTimeoutError) {
      return fail('timeout', 'unknown', 'timeout', requestMasked);
    }
    if (e instanceof BodyTooLargeError) {
      return fail('unknown', 'unknown', 'too_large', requestMasked);
    }
    return fail('unknown', 'unknown', 'network', requestMasked);
  }
  const status = res.status;
  const common = {
    httpStatus: status,
    responseBytes: res.body.length,
  };
  const text = () =>
    scrubSecret(res.body.toString('utf8').slice(0, 64 * 1024), req.auth.secret);
  if (status >= 500) {
    return fail('unknown', 'unknown', `http_${status}`, requestMasked, common);
  }
  if (status >= 300 && status < 400) {
    return fail('unknown', 'unknown', 'redirect', requestMasked, common);
  }
  const reject = authRejection(status, res.headers, res.body, req.auth.kind);
  if (reject === 'key') {
    return fail('auth_failed', 'failed', 'http_401', requestMasked, {
      ...common,
      errorText: null,
      authReject: reject,
    });
  }
  if (status >= 400) {
    return fail('http_error', 'failed', `http_${status}`, requestMasked, {
      ...common,
      errorText: apiErrorText(text(), mask),
      ...(reject ? { authReject: reject } : {}),
    });
  }
  let data: string | null = null;
  const raw = text();
  if (raw.trim()) {
    try {
      data = JSON.stringify(JSON.parse(raw));
      if (Buffer.byteLength(data, 'utf8') > EXEC_MODEL_DATA_BYTES) {
        data = null;
      }
    } catch {
      data = null;
    }
  }
  return {
    ...base,
    ...common,
    outcome: 'ok',
    status: 'done',
    requestMasked,
    durationMs: Date.now() - started,
    error: null,
    data,
  };
}
