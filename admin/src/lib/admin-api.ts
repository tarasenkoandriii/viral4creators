// Клиентский fetch-слой. Конверт ответа — тот же
// { success: true, data, meta } | { success: false, error, meta }, что
// возвращает глобальный ResponseInterceptor/HttpExceptionFilter бэкенда
// (backend/src/common/{interceptors,filters}) — переиспользуется формат
// парсинга, не переизобретается заново. Аутентификация — httpOnly cookie
// AdminSession, НЕ заголовок (в отличие от TMA-фронтенда) —
// credentials: 'include' обязателен на каждый запрос, иначе браузер не
// отправит cookie в cross-origin запросе на backend-домен (см.
// backend/src/modules/admin-auth/admin-auth.controller.ts, CORS
// credentials: true в main.ts).
//
// Перенесено из проекта Devil's Advocate
// (apps/admin/src/lib/admin-api.ts) — общий паттерн, не специфика того
// продукта.

// Backend has a global route prefix (`app.setGlobalPrefix('api')` in
// backend/src/main.ts — the same reason health lives at `/api/health`,
// not `/health`), so every path this file builds (`/admin/auth/...`,
// `/admin/sessions`, `/admin/settings`, ...) needs that `/api` segment
// already present in the base URL. NEXT_PUBLIC_API_BASE_URL must include
// it (see admin/.env.example and docker-compose.dev.yml's `admin`
// service) — a base URL without `/api` produces a 404 on every request.
const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3000/api';

interface ApiSuccessResponse<T> {
  success: true;
  data: T;
}

interface ApiErrorResponse {
  success: false;
  error: { message: string; code?: string };
}

type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;

export class ApiRequestError extends Error {
  constructor(
    message: string,
    public readonly httpStatus: number,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

interface ApiReqOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | undefined>;
}

function buildQuery(query?: ApiReqOptions['query']): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

async function apiReq(path: string, options: ApiReqOptions = {}): Promise<Response> {
  return fetch(`${API_BASE_URL}${path}${buildQuery(options.query)}`, {
    method: options.method ?? 'GET',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
}

async function handle<T>(response: Response): Promise<T> {
  let body: ApiResponse<T>;
  try {
    body = await response.json();
  } catch {
    throw new ApiRequestError('Сервер вернул некорректный ответ', response.status);
  }

  if (!body.success) {
    // Ответ шлюза вида `{"error":"…"}` или без `error` вовсе не должен
    // превращаться в TypeError вместо сообщения (этап 50, В-5.14).
    const err = (body as { error?: { message?: string } | string }).error;
    const message =
      typeof err === 'string'
        ? err
        : err?.message || `Сервер ответил ${response.status}`;
    throw new ApiRequestError(message, response.status);
  }
  return body.data;
}

export async function apiGet<T>(path: string, query?: ApiReqOptions['query']): Promise<T> {
  return handle<T>(await apiReq(path, { method: 'GET', query }));
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return handle<T>(await apiReq(path, { method: 'POST', body }));
}

export async function apiPatch<T>(path: string, body?: unknown): Promise<T> {
  return handle<T>(await apiReq(path, { method: 'PATCH', body }));
}

export async function apiDelete<T>(path: string): Promise<T> {
  // 204 без тела — у DELETE это норма; handle() ждёт JSON, поэтому для
  // пустого ответа возвращаем undefined как T.
  const response = await apiReq(path, { method: 'DELETE' });
  if (response.status === 204) return undefined as T;
  return handle<T>(response);
}
