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
import {
  CSV_MAX_PARTS,
  newOpKey,
  queryString,
  type CsvFile,
  type PublisherHttp,
  type Query,
  type RawGet,
} from './common-pure';

// Чистая часть (типы клиента, opKey, сегмент, ошибки) — в `common-pure.ts`.
export * from './common-pure';

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
