/**
 * Локальный https-стенд для тестов обхода и мета-теста SSRF: один сервер
 * на 127.0.0.1 отвечает за много «сайтов» по заголовку Host, а резолвер —
 * подменный (`PinnedHttpDeps.lookupAll`). Настоящий `pinnedFetch` (undici,
 * TLS, SNI, ручные редиректы, лимит тела) работает поверх него без
 * изменений: подменяются только DNS и адрес подключения.
 *
 * Как устроен pin в тестах: имя резолвится в ПУБЛИЧНЫЙ адрес (по умолчанию
 * 93.184.216.34) — его проверяет блок-лист и его же сокет получает от
 * lookup; `dialOverride` переводит само подключение на 127.0.0.1:<порт>.
 * `dials` записывает, какой адрес был отдан сокету, — мета-тест rebinding
 * сверяет его с ПЕРВЫМ ответом резолвера.
 */

import { createServer, Server } from 'https';
import type { IncomingMessage, ServerResponse } from 'http';
import { AddressInfo } from 'net';
import { gzipSync } from 'zlib';
import type { PinnedAddress, PinnedHttpDeps } from '../net/pinned-fetch';
import { TEST_TLS_CERT, TEST_TLS_KEY } from './tls-fixture.testing';

export const PUBLIC_TEST_IP = '93.184.216.34';

export interface FakeRoute {
  status?: number;
  headers?: Record<string, string>;
  body?: string | Buffer;
  /** Отдать тело в gzip (Content-Encoding). */
  gzip?: boolean;
  /** Задержка ответа (таймауты). */
  delayMs?: number;
}

/** `body` — тело запроса (Э8: изменяющие вызовы коннектора «Админки»). */
export type RouteHandler = (req: IncomingMessage, body: string) => FakeRoute;

/** Запрос, дошедший до стенда, с методом, заголовками и телом (Э8). */
export interface SeenRequest {
  key: string;
  method: string;
  headers: IncomingMessage['headers'];
  body: string;
}

export class LocalSites {
  private server: Server | null = null;
  port = 0;
  /** `host` + `path?query` → ответ. */
  readonly routes = new Map<string, FakeRoute | RouteHandler>();
  /** Запросы, дошедшие до сервера: `host/path`. */
  readonly hits: string[] = [];
  /** Те же запросы с методом, заголовками и телом. */
  readonly requests: SeenRequest[] = [];
  /** Имя → адреса (или функция — для rebinding: новый ответ на каждый вызов). */
  readonly dns = new Map<string, string[] | (() => string[])>();
  readonly lookups: string[] = [];
  readonly dials: Array<{ host: string; address: string }> = [];

  async start(): Promise<this> {
    this.server = createServer(
      { cert: TEST_TLS_CERT, key: TEST_TLS_KEY },
      (req, res) => this.handle(req, res),
    );
    await new Promise<void>((resolve) =>
      this.server!.listen(0, '127.0.0.1', resolve),
    );
    this.port = (this.server.address() as AddressInfo).port;
    return this;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  /** Сайт: имя резолвится в публичный адрес, страницы — по путям. */
  site(host: string, pages: Record<string, FakeRoute | RouteHandler>): this {
    if (!this.dns.has(host)) this.dns.set(host, [PUBLIC_TEST_IP]);
    for (const [path, route] of Object.entries(pages)) {
      this.routes.set(`${host}${path}`, route);
    }
    return this;
  }

  html(body: string, extra: FakeRoute = {}): FakeRoute {
    return {
      status: 200,
      ...extra,
      headers: { 'content-type': 'text/html; charset=utf-8', ...extra.headers },
      body,
    };
  }

  deps(): PinnedHttpDeps {
    return {
      lookupAll: async (host: string) => {
        this.lookups.push(host);
        const entry = this.dns.get(host);
        if (!entry) {
          throw Object.assign(new Error(`ENOTFOUND ${host}`), {
            code: 'ENOTFOUND',
          });
        }
        const list = typeof entry === 'function' ? entry() : entry;
        return list.map((address) => ({
          address,
          family: address.includes(':') ? (6 as const) : (4 as const),
        }));
      },
      portOverride: this.port,
      dialOverride: { address: '127.0.0.1', family: 4 },
      tlsCa: TEST_TLS_CERT,
      onDial: (host: string, pinned: PinnedAddress) => {
        this.dials.push({ host, address: pinned.address });
      },
    };
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () =>
      this.dispatch(req, res, Buffer.concat(chunks).toString('utf8')),
    );
  }

  private dispatch(
    req: IncomingMessage,
    res: ServerResponse,
    reqBody: string,
  ): void {
    const host = (req.headers.host ?? '').replace(/:\d+$/, '');
    const key = `${host}${req.url ?? '/'}`;
    this.hits.push(key);
    this.requests.push({
      key,
      method: req.method ?? 'GET',
      headers: req.headers,
      body: reqBody,
    });
    const entry = this.routes.get(key);
    const route: FakeRoute = !entry
      ? {
          status: 404,
          body: 'not found',
          headers: { 'content-type': 'text/html' },
        }
      : typeof entry === 'function'
        ? entry(req, reqBody)
        : entry;
    let body: Buffer = Buffer.isBuffer(route.body)
      ? route.body
      : Buffer.from(route.body ?? '', 'utf8');
    const headers: Record<string, string> = { ...route.headers };
    if (route.gzip) {
      body = gzipSync(body);
      headers['content-encoding'] = 'gzip';
    }
    const send = () => {
      if (res.destroyed) return;
      res.writeHead(route.status ?? 200, headers);
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    if (route.delayMs) setTimeout(send, route.delayMs);
    else send();
  }
}
