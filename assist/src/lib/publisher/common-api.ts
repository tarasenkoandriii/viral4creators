/**
 * AI Publisher (P-G1) — HTTP-слой экранов кабинета (§11.1, §14.1):
 *  - JSON-запросы к `/publisher/*` через `ApiClient` кита (заголовок
 *    `X-Site-Account`, initData/cookie, `Accept-Language`);
 *  - мутации: `opKey` (UUID v4) — в ТЕЛЕ, один на попытку действия;
 *    повтор после сетевой ошибки — тем же ключом (сервер вернёт прежний
 *    результат, а не сделает второе действие);
 *  - выгрузка `?format=csv`: сервер отвечает файлом, а `ApiClient` кита
 *    разбирает только JSON-конверт, поэтому CSV читается своим запросом с
 *    той же авторизацией (кит ради этого не меняется).
 *
 * Общий для P-G1 и P-G2 (оболочка — `screens/publisher/*`).
 */

import {
  ApiError,
  SITE_ACCOUNT_HEADER,
  joinUrl,
  unwrapEnvelope,
  type ApiClient,
  type ApiClientOptions,
} from '../../kit';

export type QueryValue = string | number | boolean | null | undefined;
export type Query = Record<string, QueryValue>;

export interface CsvFile {
  filename: string;
  text: string;
  /** Частей склеено (курсор `X-Next-Before`, P-B2: до 5000 строк на часть). */
  parts?: number;
  /** Склейка остановлена на пределе частей — файл НЕ полный. */
  truncated?: boolean;
}

/** Предел склейки частей CSV: 20 × 5000 строк. */
export const CSV_MAX_PARTS = 20;

export interface PublisherHttp {
  /** `path` — от `/publisher/` без ведущего слеша: `products/<pid>/leads`. */
  get<T = unknown>(path: string, query?: Query): Promise<T>;
  /** Мутация: `opKey` кладётся в тело (переданный или новый). */
  send<T = unknown>(
    method: 'POST' | 'PATCH' | 'PUT',
    path: string,
    body?: Record<string, unknown>,
    opKey?: string
  ): Promise<T>;
  /**
   * Раскрытие ПД (контакт, заметки заявки): `POST` БЕЗ `opKey` — чтение с
   * записью в журнал доступа (Р-PUB-Z2-25, предаудит D1-02). Не `GET`:
   * барьеры CSRF веб-кабинета защищают только изменяющие методы.
   */
  reveal<T = unknown>(path: string, body: Record<string, unknown>): Promise<T>;
  /** Выгрузка списка `?format=csv` (ТЗ §8.4). */
  csv(path: string, query?: Query): Promise<CsvFile>;
  /** Текст `?format=md` (протокол eval). */
  markdown(path: string, query?: Query): Promise<CsvFile>;
}

/** Сырой GET (CSV): статус, тип, имя файла и текст. */
export type RawGet = (path: string) => Promise<{
  status: number;
  contentType: string;
  disposition: string;
  text: string;
  /** Заголовок `X-Next-Before`: курсор следующей части файла. */
  nextBefore?: string | null;
}>;

/** UUID v4 нижним регистром (`OP_KEY_RE` контракта, триггер `pub_uuid4`). */
export const OP_KEY_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function newOpKey(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Сегмент пути: id из ответа сервера, но в URL — только безопасные символы. */
const SEG = /^[A-Za-z0-9_.:-]{1,128}$/;
export function seg(v: string): string {
  if (!SEG.test(v)) {
    throw new ApiError('PUB_VALIDATION', `bad path segment`, 400);
  }
  return v;
}

export function queryString(q?: Query): string {
  if (!q) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === null || v === '') continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

const PREFIX = 'publisher/';

export function createPublisherHttp(
  client: ApiClient,
  raw: RawGet
): PublisherHttp {
  return {
    get: <T>(path: string, query?: Query) =>
      client.request<T>('GET', `${PREFIX}${path}${queryString(query)}`),
    send: <T>(
      method: 'POST' | 'PATCH' | 'PUT',
      path: string,
      body: Record<string, unknown> = {},
      opKey?: string
    ) =>
      client.request<T>(method, `${PREFIX}${path}`, {
        ...body,
        opKey: opKey ?? newOpKey(),
      }),
    reveal: <T>(path: string, body: Record<string, unknown>) =>
      client.request<T>('POST', `${PREFIX}${path}`, { ...body }),
    csv: (path: string, query?: Query) => csvAll(raw, path, query ?? {}),
    markdown: async (path: string, query?: Query) => {
      const f = await fileGet(
        raw,
        path,
        { ...query, format: 'md' },
        /text\/markdown/i,
        'md'
      );
      return { filename: f.filename, text: f.text };
    },
  };
}

/**
 * Файл (CSV/Markdown) сырым GET. Часть маршрутов отдаёт файл через общий
 * конверт (`{success:true, data:"…"}` с `Content-Type: text/csv`) — такой
 * ответ разворачивается; ошибка — тот же конверт, что у JSON (`ApiError`).
 */
async function fileGet(
  raw: RawGet,
  path: string,
  query: Query,
  type: RegExp,
  ext: string
): Promise<CsvFile & { nextBefore: string | null }> {
  const res = await raw(`${PREFIX}${path}${queryString(query)}`);
  let json: unknown = null;
  if (/^\s*\{/.test(res.text)) {
    try {
      json = JSON.parse(res.text);
    } catch {
      json = null;
    }
  }
  if (res.status >= 400) {
    unwrapEnvelope(json, res.status, path);
    throw new ApiError(`http_${res.status}`, 'HTTP error', res.status);
  }
  let text: string | null = null;
  if (
    json &&
    typeof json === 'object' &&
    (json as { success?: unknown }).success === true &&
    typeof (json as { data?: unknown }).data === 'string'
  ) {
    text = (json as { data: string }).data;
  } else if (json && typeof json === 'object') {
    unwrapEnvelope(json, 502, path);
  } else if (type.test(res.contentType)) {
    text = res.text;
  }
  if (text === null) {
    throw new ApiError('PUB_RESPONSE_INVALID', `${ext} expected`, 502);
  }
  const m = /filename="([^"]{1,120})"/.exec(res.disposition);
  return {
    filename: m ? m[1] : `publisher-export.${ext}`,
    text,
    nextBefore: res.nextBefore ?? null,
  };
}

/**
 * CSV целиком: при `X-Next-Before` дочитываются следующие части
 * (`?before=<курсор>`) и склеиваются без повторной строки заголовка; на
 * пределе `CSV_MAX_PARTS` файл помечается неполным (экран предупреждает,
 * ТЗ §8.4 — неполнота явно).
 */
export async function csvAll(
  raw: RawGet,
  path: string,
  query: Query
): Promise<CsvFile> {
  const first = await fileGet(
    raw,
    path,
    { ...query, format: 'csv' },
    /text\/csv/i,
    'csv'
  );
  let text = first.text;
  let next = first.nextBefore;
  let parts = 1;
  while (next && parts < CSV_MAX_PARTS) {
    const part = await fileGet(
      raw,
      path,
      { ...query, format: 'csv', before: next },
      /text\/csv/i,
      'csv'
    );
    const body = part.text.replace(/^[^\n]*\n?/, '');
    if (body) text = `${text.replace(/\n?$/, '\n')}${body}`;
    next = part.nextBefore;
    parts++;
  }
  return { filename: first.filename, text, parts, truncated: !!next };
}

/**
 * Сырой GET с той же авторизацией, что у `ApiClient` кита (опции — те же,
 * что App передаёт `createApiClient`).
 */
export function createRawGet(opts: ApiClientOptions): RawGet {
  const doFetch = opts.fetchImpl ?? ((...a) => fetch(...a));
  return async (path) => {
    const auth = opts.auth();
    if (!auth) throw new ApiError('no_telegram', 'No identity', 401);
    const headers: Record<string, string> = {
      Accept: 'text/csv, application/json',
      'Accept-Language': opts.locale(),
      ...auth.headers,
    };
    const accountId = opts.accountId?.() ?? null;
    if (accountId && /^[A-Za-z0-9_-]{1,64}$/.test(accountId)) {
      headers[SITE_ACCOUNT_HEADER] = accountId;
    }
    let res: Response;
    try {
      res = await doFetch(joinUrl(opts.baseUrl, path), {
        method: 'GET',
        headers,
        credentials: auth.credentials,
      });
    } catch {
      throw new ApiError('network', 'Network error', 0);
    }
    const text = await res.text();
    if (res.status === 401) {
      const e = new ApiError('UNAUTHORIZED', 'Unauthorized', 401);
      opts.onUnauthorized?.(e);
      throw e;
    }
    return {
      status: res.status,
      contentType: res.headers.get('content-type') ?? '',
      disposition: res.headers.get('content-disposition') ?? '',
      text,
      nextBefore: res.headers.get('x-next-before'),
    };
  };
}

/** Сохранить CSV у человека (браузер / WebView Telegram). */
export function downloadCsv(file: CsvFile): void {
  const md = /\.md$/i.test(file.filename);
  // BOM — чтобы Excel открыл UTF-8 кириллицу без «кракозябр».
  const blob = new Blob(md ? [file.text] : ['\ufeff', file.text], {
    type: md ? 'text/markdown;charset=utf-8' : 'text/csv;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ── Ошибки (§11.2) ───────────────────────────────────────────────────────

export interface PubErrorInfo {
  code: string;
  status: number;
  message: string;
  details: Record<string, unknown>;
}

export function pubError(e: unknown): PubErrorInfo | null {
  if (!(e instanceof ApiError)) return null;
  return {
    code: e.code,
    status: e.status,
    message: e.message,
    details: e.details ?? {},
  };
}

/**
 * Ключ попытки действия (§11.1): один `opKey` на попытку; `sig` — подпись
 * действия (путь+тело). Тот же `sig` после повторяемой ошибки — тот же
 * ключ (сервер вернёт прежний результат); другой `sig` — новый ключ (иначе
 * ДРУГОЕ действие ушло бы со старым ключом → 409 `PUB_IDEMPOTENCY_REUSED`).
 */
export interface OpKeyState {
  key: string;
  sig: string;
}
export function opKeyFor(
  prev: OpKeyState | null,
  sig: string,
  gen: () => string = newOpKey
): OpKeyState {
  return prev && prev.sig === sig ? prev : { key: gen(), sig };
}
/** После попытки: успех или неповторяемая ошибка — ключ сбрасывается. */
export function opKeyAfter(
  state: OpKeyState,
  error: unknown
): OpKeyState | null {
  return error !== null && error !== undefined && isRetryable(error)
    ? state
    : null;
}

/** Повтор с тем же `opKey` безопасен: сеть, таймаут, `PUB_BUSY`. */
export function isRetryable(e: unknown): boolean {
  return (
    e instanceof ApiError &&
    (e.code === 'network' || e.code === 'PUB_BUSY' || e.status === 0)
  );
}

/** `PUB_VALIDATION.details.fields: [{field, code}]`. */
export function fieldIssues(
  e: unknown
): Array<{ field: string; code: string }> {
  const d = pubError(e)?.details;
  if (!d || !Array.isArray(d.fields)) return [];
  return d.fields
    .slice(0, 50)
    .filter(
      (x): x is { field: string; code: string } =>
        !!x &&
        typeof x === 'object' &&
        typeof (x as { field?: unknown }).field === 'string' &&
        typeof (x as { code?: unknown }).code === 'string'
    )
    .map((x) => ({ field: x.field, code: x.code }));
}
