/**
 * Исполнение `read`-операции коннектора (ТЗ §5.4 п.3–4, §5.5, §5.7).
 *
 * SSRF-guard — несколько независимых слоёв:
 *  1. URL собирается кодом: `baseUrl` коннектора + путь операции, значения
 *     path-параметров — только «безопасные» символы (никаких `/`, `..`, `%`),
 *     query — через URLSearchParams. Модель не пишет URL никогда.
 *  2. Итоговый хост обязан быть в `allowedHosts` коннектора (а их, в свою
 *     очередь, при сохранении сверяет сервис: verified-хост сайта или
 *     SaaS-аккаунт с отметкой владельца) — иначе `blocked` без сети.
 *  3. Сеть — `pinnedFetch` (site-crawl/net): только https:443, без
 *     IP-литералов, резолв ОДИН раз с проверкой каждого адреса блок-листом
 *     частных/служебных диапазонов, подключение к проверенному адресу
 *     (DNS-rebinding не к чему применить), редиректы НЕ исполняются
 *     (`maxRedirects: 0`: 3xx — `blocked`), таймаут 10 с, тело ≤ 1 МБ.
 *
 * Сбои (§5.7): 5xx/таймаут — один повтор с паузой, затем честный отказ
 * (данных модели не передаём — ответ сотруднику пишет код, не модель);
 * 401 с признаком отказа ПО КЛЮЧУ коннектора (`authRejection`: вызов
 * `WWW-Authenticate` со схемой ключа или код ключа в теле) — `auth_failed`
 * (коннектор на паузу — решает сервис); 401 без признака — `http_error`
 * с `authReject: 'unclear'` (пауза — только после отказов разным
 * сотрудникам, `ConnectorsService.markCalled`); 403 — `http_error`: это
 * отказ по сотруднику (`X-V4C-Actor`), коннектор исправен (аудит Н-3);
 * прочие 4xx — `http_error` (только код); не JSON — `bad_response`.
 *
 * Секрет: подставляется только в заголовок запроса; в результат, журнал и
 * ошибки не попадает; если API эхом вернул секрет в теле — он вырезается до
 * того, как тело увидит модель (`scrubSecret`).
 */
import { BodyTooLargeError } from '../../shared/external-url-guard';
import {
  FetchTimeoutError,
  PinnedHttpDeps,
  RedirectOffsiteError,
  SsrfBlockedError,
  pinnedFetch,
} from '../site-crawl/net/pinned-fetch';
import type { OperationParam } from './openapi-import';

export const EXEC_TIMEOUT_MS = 10_000;
export const EXEC_MAX_BYTES = 1024 * 1024;
/** Сколько данных ответа (после маскирования) уходит модели. */
export const EXEC_MODEL_DATA_BYTES = 8 * 1024;
export const EXEC_RETRY_PAUSE_MS = 400;

export type ExecOutcome =
  | 'ok'
  | 'http_error'
  | 'timeout'
  | 'blocked'
  | 'invalid_params'
  | 'bad_response'
  | 'auth_failed';

export interface ConnectorAuth {
  kind: 'none' | 'bearer' | 'basic' | 'header';
  headerName?: string | null;
  /** Открытый секрет — только в памяти на время вызова. */
  secret?: string | null;
}

export interface ExecRequest {
  baseUrl: string;
  allowedHosts: readonly string[];
  method: string;
  path: string;
  params: readonly OperationParam[];
  args: Record<string, unknown>;
  auth: ConnectorAuth;
  /** `X-V4C-Actor` — id сотрудника у заказчика (для их аудита, §5.5). */
  actor: string;
}

export interface ExecResult {
  outcome: ExecOutcome;
  httpStatus: number | null;
  durationMs: number;
  /** Маскированный запрос для журнала (без заголовков). */
  requestMasked: {
    method: string;
    path: string;
    query: Record<string, string>;
  };
  responseBytes: number | null;
  /** JSON-текст для модели (усечён, секрет вырезан) — только при ok. */
  data: string | null;
  /** Код ошибки для журнала (без тела ответа). */
  error: string | null;
  /** 401: отказ по ключу коннектора или неясный (аудит Н-3). */
  authReject?: AuthRejection;
}

/**
 * Чем был 401/403 API заказчика (аудит Н-3):
 *  - `key` — отказ по КЛЮЧУ коннектора: 401 и вызов `WWW-Authenticate` со
 *    схемой ключа (Bearer, для Basic-ключа — Basic; RFC 6750 §3 / RFC 7617)
 *    или машинный код ключа в теле (`invalid_token`, `invalid_api_key`, …).
 *    Генератор (guide-connector.guard) отвечает так ТОЛЬКО на неверный
 *    ключ — коннектор на паузу сразу;
 *  - `unclear` — 401 без признака: мог быть и ключ, и сотрудник — одиночный
 *    отказ коннектор не паузит;
 *  - `null` — не 401. 403 — всегда отказ по сотруднику (у генератора
 *    `ACTOR_INVALID`), коннектор НЕ паузит никогда.
 */
export type AuthRejection = 'key' | 'unclear';

const KEY_REJECT_CODES = new Set([
  'invalid_token',
  'invalid_api_key',
  'invalid_key',
  'api_key_invalid',
  'key_invalid',
  'token_invalid',
  'invalid_credentials',
  'connector_key_invalid',
]);

function bodyKeyCode(body: Buffer | string): boolean {
  const text = (typeof body === 'string' ? body : body.toString('utf8')).slice(
    0,
    4096,
  );
  if (!text.trim().startsWith('{')) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  const codes: unknown[] = [];
  const o = parsed as Record<string, unknown> | null;
  if (o && typeof o === 'object') {
    codes.push(o.code, o.error, o.error_code, o.errorCode);
    const e = o.error as Record<string, unknown> | null;
    if (e && typeof e === 'object') codes.push(e.code, e.type);
  }
  return codes.some(
    (c) =>
      typeof c === 'string' && KEY_REJECT_CODES.has(c.trim().toLowerCase()),
  );
}

export function authRejection(
  status: number,
  headers: Record<string, string | string[] | undefined> | undefined,
  body: Buffer | string,
  authKind: ConnectorAuth['kind'],
): AuthRejection | null {
  if (status !== 401) return null;
  const raw = headers?.['www-authenticate'];
  const challenge = Array.isArray(raw) ? raw.join(', ') : (raw ?? '');
  const schemes = authKind === 'basic' ? 'bearer|basic' : 'bearer';
  if (new RegExp(`(?:^|,)\\s*(?:${schemes})(?:\\s|,|$)`, 'i').test(challenge)) {
    return 'key';
  }
  return bodyKeyCode(body) ? 'key' : 'unclear';
}

export {
  ParamValidationError,
  validateArgs,
  type ValidatedArgs,
} from './connector-args';
import {
  ParamValidationError,
  validateArgs,
  type ValidatedArgs,
} from './connector-args';

/** Собрать URL: baseUrl + путь с подстановкой, query. Бросает при `{}` без значения. */
export function buildUrl(
  baseUrl: string,
  pathTemplate: string,
  path: Record<string, string>,
  query: Record<string, string | string[]>,
): URL {
  const filled = pathTemplate.replace(/\{([^}]+)\}/g, (_m, name: string) => {
    const v = path[name];
    if (v === undefined)
      throw new ParamValidationError(`нет параметра ${name}`);
    return encodeURIComponent(v);
  });
  const u = new URL(`${baseUrl}${filled}`);
  for (const [k, v] of Object.entries(query)) {
    // Массив — повтором ключа (OpenAPI form/explode по умолчанию).
    if (Array.isArray(v)) for (const x of v) u.searchParams.append(k, x);
    else u.searchParams.set(k, v);
  }
  return u;
}

/** Хост URL в списке разрешённых (точное совпадение, без поддоменов). */
export function hostAllowed(u: URL, allowedHosts: readonly string[]): boolean {
  const h = u.hostname.toLowerCase().replace(/\.$/, '');
  return (
    u.protocol === 'https:' &&
    u.port === '' &&
    !u.username &&
    !u.password &&
    allowedHosts.some((a) => a.toLowerCase() === h)
  );
}

/**
 * Имена заголовков, которые нельзя занять ключом API (аудит Э7): служебные
 * HTTP (подмена Host/длины/кодирования ломает запрос к закреплённому IP),
 * наш `x-v4c-actor` и то, что выставляет pinnedFetch.
 */
const FORBIDDEN_AUTH_HEADERS = new Set([
  'host',
  'content-length',
  'content-type',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'upgrade',
  'te',
  'trailer',
  'expect',
  'accept',
  'accept-encoding',
  'x-v4c-actor',
  // Э8 (аудит): ключ API не занимает заголовки изменяющего запроса — иначе
  // секрет уходил бы как Idempotency-Key (один на все «Да») или как подпись.
  'idempotency-key',
  'x-v4c-signature',
]);

export function authHeaderNameAllowed(name: string): boolean {
  const n = name.toLowerCase();
  return (
    /^[a-z0-9-]{1,64}$/.test(n) &&
    !FORBIDDEN_AUTH_HEADERS.has(n) &&
    !n.startsWith('proxy-')
  );
}

export function authHeaders(auth: ConnectorAuth): Record<string, string> {
  if (auth.kind === 'none' || !auth.secret) return {};
  if (auth.kind === 'bearer') return { authorization: `Bearer ${auth.secret}` };
  if (auth.kind === 'basic') {
    return {
      authorization: `Basic ${Buffer.from(auth.secret, 'utf8').toString('base64')}`,
    };
  }
  const name = (auth.headerName ?? '').toLowerCase();
  if (!authHeaderNameAllowed(name)) return {};
  return { [name]: auth.secret };
}

/**
 * Вырезать секрет из текста ответа (это JSON.stringify тела): сам секрет, его
 * JSON-экранированная запись (с `"` или `\\` в секрете), base64 и
 * base64url (Basic), URL-кодирование и — для «логин:пароль» —
 * отдельно пароль (API эхом может вернуть только его). Аудит Э7: раньше
 * экранированный или base64url-вариант доходил до модели.
 */
export function scrubSecret(
  text: string,
  secret: string | null | undefined,
): string {
  if (!secret || secret.length < 4) return text;
  const raw = [secret];
  const colon = secret.indexOf(':');
  if (colon > 0 && secret.length - colon - 1 >= 6) {
    raw.push(secret.slice(colon + 1));
  }
  const variants = new Set<string>();
  for (const r of raw) {
    variants.add(r);
    variants.add(JSON.stringify(r).slice(1, -1));
    variants.add(Buffer.from(r, 'utf8').toString('base64'));
    variants.add(Buffer.from(r, 'utf8').toString('base64').replace(/=+$/, ''));
    variants.add(Buffer.from(r, 'utf8').toString('base64url'));
    variants.add(encodeURIComponent(r));
  }
  // Длинные варианты — первыми: короткий (пароль) не должен разрезать длинный.
  const ordered = [...variants]
    .filter((v) => v.length >= 4)
    .sort((a, b) => b.length - a.length);
  let out = text;
  for (const v of ordered) out = out.split(v).join('[секрет скрыт]');
  return out;
}

export function maskedRequest(
  method: string,
  pathTemplate: string,
  path: Record<string, string>,
  query: Record<string, string | string[]>,
  mask: (s: string) => string,
): ExecResult['requestMasked'] {
  const p = pathTemplate.replace(/\{([^}]+)\}/g, (_m, n: string) =>
    path[n] !== undefined ? mask(path[n]) : `{${n}}`,
  );
  const q: Record<string, string> = {};
  for (const [k, v] of Object.entries(query)) {
    q[k] = Array.isArray(v) ? v.map(mask).join(',') : mask(v);
  }
  return { method, path: p, query: q };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Один read-вызов (с одним повтором на 5xx/таймаут). `mask` — маскирование
 * значений для журнала (e-mail, телефоны). Сеть — только через deps.
 */
export async function executeRead(
  req: ExecRequest,
  deps: Partial<PinnedHttpDeps> | undefined,
  mask: (s: string) => string,
  retryPauseMs = EXEC_RETRY_PAUSE_MS,
): Promise<ExecResult> {
  const started = Date.now();
  const method = req.method.toUpperCase() === 'HEAD' ? 'HEAD' : 'GET';
  const base: Omit<ExecResult, 'outcome' | 'requestMasked'> = {
    httpStatus: null,
    durationMs: 0,
    responseBytes: null,
    data: null,
    error: null,
  };
  let parts: ValidatedArgs;
  try {
    parts = validateArgs(req.params, req.args);
  } catch (e) {
    return {
      ...base,
      outcome: 'invalid_params',
      requestMasked: { method, path: req.path, query: {} },
      durationMs: Date.now() - started,
      error:
        e instanceof ParamValidationError ? e.detail.slice(0, 200) : 'invalid',
    };
  }
  const requestMasked = maskedRequest(
    method,
    req.path,
    parts.path,
    parts.query,
    mask,
  );
  let url: URL;
  try {
    url = buildUrl(req.baseUrl, req.path, parts.path, parts.query);
  } catch {
    return { ...base, outcome: 'invalid_params', requestMasked, error: 'url' };
  }
  if (!hostAllowed(url, req.allowedHosts)) {
    return {
      ...base,
      outcome: 'blocked',
      requestMasked,
      durationMs: Date.now() - started,
      error: 'host_not_allowed',
    };
  }
  const headers = {
    accept: 'application/json',
    'x-v4c-actor': req.actor.slice(0, 128),
    ...authHeaders(req.auth),
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await sleep(retryPauseMs);
    let res;
    try {
      res = await pinnedFetch(
        url.href,
        {
          method,
          headers,
          maxBytes: EXEC_MAX_BYTES,
          timeoutMs: EXEC_TIMEOUT_MS,
          maxRedirects: 0,
          sameOrigin: true,
        },
        deps,
      );
    } catch (e) {
      if (e instanceof FetchTimeoutError) {
        if (attempt === 0) continue;
        return {
          ...base,
          outcome: 'timeout',
          requestMasked,
          durationMs: Date.now() - started,
          error: 'timeout',
        };
      }
      if (e instanceof SsrfBlockedError || e instanceof RedirectOffsiteError) {
        return {
          ...base,
          outcome: 'blocked',
          requestMasked,
          durationMs: Date.now() - started,
          error: 'ssrf',
        };
      }
      if (e instanceof BodyTooLargeError) {
        return {
          ...base,
          outcome: 'bad_response',
          requestMasked,
          durationMs: Date.now() - started,
          error: 'too_large',
        };
      }
      if (attempt === 0) continue;
      return {
        ...base,
        outcome: 'timeout',
        requestMasked,
        durationMs: Date.now() - started,
        error: 'network',
      };
    }
    const status = res.status;
    const common = {
      ...base,
      requestMasked,
      httpStatus: status,
      responseBytes: res.body.length,
      durationMs: Date.now() - started,
    };
    if (status >= 500) {
      if (attempt === 0) continue;
      return { ...common, outcome: 'http_error', error: `http_${status}` };
    }
    if (status >= 300 && status < 400) {
      return { ...common, outcome: 'blocked', error: 'redirect' };
    }
    const reject = authRejection(status, res.headers, res.body, req.auth.kind);
    if (reject === 'key') {
      return {
        ...common,
        outcome: 'auth_failed',
        error: 'http_401',
        authReject: reject,
      };
    }
    if (reject === 'unclear') {
      return {
        ...common,
        outcome: 'http_error',
        error: 'http_401',
        authReject: reject,
      };
    }
    if (status >= 400) {
      return { ...common, outcome: 'http_error', error: `http_${status}` };
    }
    if (method === 'HEAD') return { ...common, outcome: 'ok', data: '{}' };
    let parsed: unknown;
    try {
      parsed = JSON.parse(res.body.toString('utf8'));
    } catch {
      return { ...common, outcome: 'bad_response', error: 'not_json' };
    }
    // Данные ответа уходят модели как ДАННЫЕ (размеченный блок промпта);
    // ПД не маскируются — сотрудник работает с заказами в своей админке
    // (маскирование по настройке — хвост Э7). Секрет вырезается всегда.
    let text = scrubSecret(JSON.stringify(parsed), req.auth.secret);
    if (Buffer.byteLength(text, 'utf8') > EXEC_MODEL_DATA_BYTES) {
      text = `${Buffer.from(text, 'utf8').subarray(0, EXEC_MODEL_DATA_BYTES).toString('utf8')}…[усечено]`;
    }
    return { ...common, outcome: 'ok', data: text };
  }
  /* istanbul ignore next — цикл выше всегда возвращает */
  return { ...base, outcome: 'timeout', requestMasked, error: 'unreachable' };
}
