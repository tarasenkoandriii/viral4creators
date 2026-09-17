/**
 * HTTP API — doc/LIVE-LOGIN-RELAY-SPEC.md §7. Без фреймворка (`node:http`
 * напрямую) — четыре маршрута не оправдывают добавление зависимости
 * (§3 спеки).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { assertRelaySecret, UnauthorizedError } from './auth';
import {
  SessionLimitError,
  SessionNotFoundError,
  SessionNotReadyError,
  type SessionManager,
} from './session-manager';
import { SessionAlreadyClosedError } from './session';
import type { Logger } from './logger';

/** §10.3 — не про производительность, а про дешёвую защиту от
 * тривиального злоупотребления телом произвольного размера. */
const MAX_BODY_BYTES = 16 * 1024;

/** Только веб-схемы: см. разбор в `parseCreateSessionBody` — у
 * `file:`/`data:`/`javascript:` origin равен "null", и сверка
 * origin'ов друг с другом их пропускала. */
const ALLOWED_PROTOCOLS = ['http:', 'https:'];

export interface RouteDeps {
  relaySecret: string;
  sessionManager: SessionManager;
  logger: Logger;
  wsPathFor: (sessionId: string) => string;
  isShuttingDown: () => boolean;
}

export async function handleHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: RouteDeps,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://internal');
  const method = req.method ?? 'GET';

  if (method === 'GET' && url.pathname === '/health') {
    return respondJson(res, 200, {
      ok: true,
      activeSessions: deps.sessionManager.activeCount,
      maxSessions: deps.sessionManager.maxConcurrentSessions,
    });
  }

  try {
    assertRelaySecret(
      headerString(req.headers['x-relay-secret']),
      deps.relaySecret,
    );
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return respondJson(res, 401, { error: err.message });
    }
    throw err;
  }

  if (method === 'POST' && url.pathname === '/sessions') {
    return handleCreateSession(req, res, deps);
  }

  const resultMatch = url.pathname.match(/^\/sessions\/([^/]+)\/result$/);
  if (method === 'GET' && resultMatch) {
    return handleGetResult(resultMatch[1], res, deps);
  }

  const deleteMatch = url.pathname.match(/^\/sessions\/([^/]+)$/);
  if (method === 'DELETE' && deleteMatch) {
    return handleDelete(deleteMatch[1], res, deps);
  }

  return respondJson(res, 404, { error: 'not found' });
}

async function handleCreateSession(
  req: IncomingMessage,
  res: ServerResponse,
  deps: RouteDeps,
): Promise<void> {
  if (deps.isShuttingDown()) {
    return respondJson(res, 503, { error: 'сервис перезапускается' });
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    const status = err instanceof BodyTooLargeError ? 413 : 400;
    return respondJson(res, status, { error: (err as Error).message });
  }

  const parsed = parseCreateSessionBody(body);
  if (!parsed.ok) {
    return respondJson(res, 400, { error: parsed.error });
  }

  try {
    const session = await deps.sessionManager.createSession(
      parsed.startUrl,
      parsed.allowedOrigin,
    );
    return respondJson(res, 201, {
      sessionId: session.id,
      streamToken: session.streamToken,
      wsPath: deps.wsPathFor(session.id),
    });
  } catch (err) {
    if (err instanceof SessionLimitError) {
      return respondJson(res, 503, { error: err.message });
    }
    deps.logger.error('session launch failed', { error: String(err) });
    return respondJson(res, 502, {
      error: `запуск браузера/навигация провалились: ${(err as Error).message}`,
    });
  }
}

/** Экспортируется ради тестов (этап 108 — до него у `http-routes.ts` не
 * было ни одного теста, притом что именно здесь живёт проверка
 * startUrl/allowedOrigin). */
export function parseCreateSessionBody(
  body: unknown,
):
  | { ok: true; startUrl: string; allowedOrigin: string }
  | { ok: false; error: string } {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, error: 'тело запроса должно быть JSON-объектом' };
  }
  const { startUrl, allowedOrigin } = body as Record<string, unknown>;
  if (typeof startUrl !== 'string' || typeof allowedOrigin !== 'string') {
    return {
      ok: false,
      error: 'startUrl и allowedOrigin обязательны и должны быть строками',
    };
  }
  let startParsed: URL;
  let allowedParsed: URL;
  try {
    startParsed = new URL(startUrl);
    allowedParsed = new URL(allowedOrigin);
  } catch {
    return { ok: false, error: 'startUrl/allowedOrigin — не валидные URL' };
  }
  // Найдено аудитом этапа 108: одной сверки origin'ов недостаточно —
  // у `file:`/`data:`/`javascript:` origin равен строке "null", то есть
  // `new URL('file:///etc/passwd').origin === new
  // URL('file:///что-угодно').origin` и проверка «origin совпал»
  // проходит. Реле в этом случае честно открыло бы локальный файл
  // контейнера и транслировало бы его человеку по WS. Спека (§7) сама
  // называет эту проверку «дешёвой защитой от опечатки/бага
  // вызывающего кода» — вот ровно этот класс опечатки она и не ловила.
  // Настоящий SSRF-контроль по-прежнему на стороне backend (§8.2
  // основного ТЗ), здесь — только схема.
  if (!ALLOWED_PROTOCOLS.includes(startParsed.protocol)) {
    return {
      ok: false,
      error: `startUrl должен быть http(s) — получено ${startParsed.protocol}`,
    };
  }
  if (!ALLOWED_PROTOCOLS.includes(allowedParsed.protocol)) {
    return {
      ok: false,
      error: `allowedOrigin должен быть http(s) — получено ${allowedParsed.protocol}`,
    };
  }
  const startOrigin = startParsed.origin;
  const allowedOriginNormalized = allowedParsed.origin;
  if (startOrigin !== allowedOriginNormalized) {
    return {
      ok: false,
      error: 'startUrl и allowedOrigin должны совпадать по origin',
    };
  }
  return { ok: true, startUrl, allowedOrigin: allowedOriginNormalized };
}

async function handleGetResult(
  sessionId: string,
  res: ServerResponse,
  deps: RouteDeps,
): Promise<void> {
  try {
    const result = await deps.sessionManager.finalizeSession(sessionId);
    return respondJson(res, 200, result);
  } catch (err) {
    if (err instanceof SessionNotFoundError) {
      return respondJson(res, 404, { error: err.message });
    }
    if (err instanceof SessionNotReadyError) {
      return respondJson(res, 409, { error: err.message });
    }
    if (err instanceof SessionAlreadyClosedError) {
      // Отличается от 404 (сессии никогда не было/уже выселена) — здесь
      // сессия существовала, но её принудительно закрыли (таймаут/DELETE/
      // shutdown) раньше, чем backend успел забрать результат (найдено
      // аудитом, гонка close()/finalize() — см. session.ts).
      return respondJson(res, 410, { error: err.message });
    }
    deps.logger.error('finalize failed', { sessionId, error: String(err) });
    return respondJson(res, 502, { error: (err as Error).message });
  }
}

async function handleDelete(
  sessionId: string,
  res: ServerResponse,
  deps: RouteDeps,
): Promise<void> {
  await deps.sessionManager.cancelSession(sessionId);
  res.writeHead(204);
  res.end();
}

class BodyTooLargeError extends Error {}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks: Buffer[] = [];
    let settled = false;

    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        if (!settled) {
          settled = true;
          reject(new BodyTooLargeError('тело запроса превышает лимит'));
        }
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('тело запроса — не валидный JSON'));
      }
    });
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

function headerString(
  value: string | string[] | undefined,
): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function respondJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(data);
}
