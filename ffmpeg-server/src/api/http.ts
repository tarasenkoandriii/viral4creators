/**
 * HTTP-примитивы на node:http: чтение тела с потоковым лимитом, JSON-ответы
 * в конверте `{data:…}` (совместимо с FfmpegApiService) и ошибки
 * `{error:{code,message}}`.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Ctx } from '../context';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
};

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, {
    ...BASE_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(text)),
    ...headers,
  });
  res.end(text);
}

export function sendData(
  res: ServerResponse,
  status: number,
  data: unknown,
  headers: Record<string, string> = {},
): void {
  sendJson(res, status, { data }, headers);
}

export function sendError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  headers: Record<string, string> = {},
): void {
  sendJson(res, status, { error: { code, message } }, headers);
}

export function sendText(
  res: ServerResponse,
  status: number,
  text: string,
  contentType = 'text/plain; charset=utf-8',
): void {
  res.writeHead(status, {
    ...BASE_HEADERS,
    'Content-Type': contentType,
    'Content-Length': String(Buffer.byteLength(text)),
  });
  res.end(text);
}

/**
 * Тело запроса не больше `max` байт: Content-Length проверяется сразу,
 * фактические байты — по мере чтения (заголовку не доверяем).
 */
export function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  const declared = req.headers['content-length'];
  if (declared !== undefined && Number(declared) > max) {
    return Promise.reject(
      new HttpError(
        413,
        'PAYLOAD_TOO_LARGE',
        `request body exceeds ${max} bytes`,
        {
          Connection: 'close',
        },
      ),
    );
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    req.on('data', (c: Buffer) => {
      if (failed) return;
      size += c.length;
      if (size > max) {
        failed = true;
        reject(
          new HttpError(
            413,
            'PAYLOAD_TOO_LARGE',
            `request body exceeds ${max} bytes`,
            {
              Connection: 'close',
            },
          ),
        );
        req.resume();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks));
    });
    req.on('error', (e) => {
      if (!failed) {
        failed = true;
        reject(e);
      }
    });
  });
}

export async function readJson(
  req: IncomingMessage,
  max: number,
  opts: { allowEmpty?: boolean } = {},
): Promise<unknown> {
  const ct = String(req.headers['content-type'] ?? '');
  const buf = await readBody(req, max);
  if (buf.length === 0 && opts.allowEmpty) return {};
  if (ct && !/^application\/json\b/i.test(ct)) {
    throw new HttpError(
      400,
      'INVALID_REQUEST',
      'Content-Type must be application/json',
    );
  }
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new HttpError(400, 'INVALID_REQUEST', 'body is not valid JSON');
  }
}

/** Одиночный заголовок ASCII ограниченной длины или null. */
export function header(req: IncomingMessage, name: string): string | null {
  const v = req.headers[name.toLowerCase()];
  if (Array.isArray(v)) return null;
  return v === undefined ? null : v;
}

/**
 * 404 — только «записи нет в доверенной БД» (ТЗ §5.4: by-key 404 не
 * разрешает отправить задачу другому провайдеру). В recovery (БД
 * потеряна/восстановлена из копии) или при недоступной БД отсутствие
 * записи ничего не доказывает → 503 с Retry-After.
 */
export function notFound(ctx: Ctx, message: string): HttpError {
  let mode: string;
  try {
    mode = ctx.control.get().mode;
  } catch {
    return unavailable();
  }
  if (!ctx.db.ping()) return unavailable();
  if (mode === 'recovery') {
    return new HttpError(
      503,
      'RECOVERY',
      'server is in recovery: a missing record is not authoritative',
      { 'Retry-After': '60' },
    );
  }
  return new HttpError(404, 'NOT_FOUND', message);
}

export function unavailable(): HttpError {
  return new HttpError(503, 'UNAVAILABLE', 'storage is unavailable', {
    'Retry-After': '30',
  });
}
