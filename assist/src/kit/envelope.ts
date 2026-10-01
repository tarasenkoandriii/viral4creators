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

/** Ошибка API с кодом сервера — экраны ветвятся по `code`, не по тексту. */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly requestId?: string;

  constructor(
    code: string,
    message: string,
    status: number,
    requestId?: string
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.requestId = requestId;
  }
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
    throw new ApiError(code, message, status, requestId);
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
