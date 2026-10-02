/* СГЕНЕРИРОВАНО scripts/sync-site-tma-kit.mjs — не править. Источник: site-tma-kit/src/envelope.ts */
/**
 * Конверт ответа API `{ success, data, error, meta }` — та же форма, что
 * отдаёт `ResponseInterceptor` генератора (`frontend/src/services/api.ts`,
 * `ApiResponse`), её же держит `sites-backend`.
 *
 * Разворот вынесен в чистую функцию, чтобы проверяться скриптом без
 * сети: от него зависит, увидит ли человек «Запись пока не видна» с
 * сервера или безликое «что-то пошло не так».
 */

export interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  error?: { code?: string; message?: string; details?: unknown };
  meta?: { timestamp?: string; requestId?: string };
}

/**
 * Ошибка API с кодом сервера — экраны ветвятся по `code`, не по тексту.
 * `details` — `error.details` конверта как есть (объект): построчные ошибки
 * полей форм (`errors[]` у `ENGAGEMENT_INVALID`, `HANDOFF_CONFIG_INVALID`,
 * `WIDGET_CONFIG_INVALID` …) — читать через `fieldErrors(e)`.
 */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly requestId?: string;
  readonly details?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    status: number,
    requestId?: string,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.requestId = requestId;
    if (details) this.details = details;
  }
}

export interface FieldError {
  /** Путь поля в теле запроса (`triggers[0].text.ru`), '' — тело целиком. */
  path: string;
  /** Машинный код (`too_long`, `type`, …) — текст подбирает экран. */
  code: string;
}

/**
 * Ошибки полей из `details.errors` (строгий разбор: только `{ path, code }`
 * строками, не больше 50 — длинный список человеку всё равно не прочесть).
 */
export function fieldErrors(e: unknown): FieldError[] {
  if (!(e instanceof ApiError) || !e.details) return [];
  const list = e.details.errors;
  if (!Array.isArray(list)) return [];
  const out: FieldError[] = [];
  for (const x of list.slice(0, 50)) {
    if (
      isObject(x) &&
      typeof x.path === 'string' &&
      x.path.length <= 200 &&
      typeof x.code === 'string' &&
      /^[a-z][a-z0-9_]{0,40}$/.test(x.code)
    ) {
      out.push({ path: x.path, code: x.code });
    }
  }
  return out;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Достаёт `data` из конверта или бросает `ApiError`.
 *
 * - `{ success: true, data }` → `data`; двойной конверт тоже терпим —
 *   урок генератора (`frontend/src/lib/unwrap-api-data.ts`): фронт и бэк
 *   деплоятся отдельно, и порядок деплоя не должен ломать экран;
 * - `{ success: false, error }` или HTTP ≥ 400 → `ApiError` с кодом и
 *   текстом сервера (тексты ошибок сервер пишет человеку сам);
 * - тело не JSON-конверт → `ApiError('bad_response')`: молча вернуть
 *   `undefined` значило бы упасть позже в экране с непонятной ошибкой.
 */
export function unwrapEnvelope<T>(
  body: unknown,
  status: number,
  what: string
): T {
  if (!isObject(body) || typeof body.success !== 'boolean') {
    throw new ApiError(
      status >= 400 ? `http_${status}` : 'bad_response',
      `Неожиданный ответ сервера: ${what}`,
      status
    );
  }
  const requestId = isObject(body.meta)
    ? (body.meta.requestId as string | undefined)
    : undefined;

  if (body.success !== true || status >= 400) {
    const err = isObject(body.error) ? body.error : {};
    const code = typeof err.code === 'string' ? err.code : `http_${status}`;
    const message =
      typeof err.message === 'string' && err.message
        ? err.message
        : `Ошибка сервера: ${what}`;
    const details = isObject(err.details) ? err.details : undefined;
    throw new ApiError(code, message, status, requestId, details);
  }

  let data: unknown = body.data;
  if (isObject(data) && data.success === true && 'data' in data) {
    data = data.data;
  }
  if (data === undefined) {
    throw new ApiError('empty_response', `Пустой ответ: ${what}`, status);
  }
  return data as T;
}
