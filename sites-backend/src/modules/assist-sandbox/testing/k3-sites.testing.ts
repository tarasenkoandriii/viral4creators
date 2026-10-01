/**
 * Локальный https-стенд тестов песочницы K3 — тот же приём, что у стенда
 * K1 (site-crawl/testing/local-sites.testing.ts): один сервер на 127.0.0.1
 * отвечает за много «сайтов» по Host, DNS подменён (имя → публичный адрес,
 * подключение — на локальный порт), а настоящий `pinnedFetch` (undici, TLS,
 * SNI, ручные редиректы, IP-pin) работает без изменений. Отличие — свой
 * сертификат на обычные домены (`k3sbNN.com`): песочница отвергает зону
 * `.example` ещё до сети (k3-tls.testing.ts).
 */
import { createServer, Server } from 'https';
import type { IncomingMessage, ServerResponse } from 'http';
import { AddressInfo } from 'net';
import type {
  PinnedAddress,
  PinnedHttpDeps,
} from '../../site-crawl/net/pinned-fetch';
import { K3_TLS_CERT, K3_TLS_KEY } from './k3-tls.testing';

export const K3_PUBLIC_IP = '93.184.216.34';

export interface K3Route {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
}

export class K3Sites {
  private server: Server | null = null;
  port = 0;
  readonly routes = new Map<string, K3Route>();
  /** Запросы, дошедшие до сервера: `host/path`. */
  readonly hits: string[] = [];
  readonly dns = new Map<string, string[]>();
  readonly lookups: string[] = [];
  readonly dials: Array<{ host: string; address: string }> = [];

  async start(): Promise<this> {
    this.server = createServer(
      { cert: K3_TLS_CERT, key: K3_TLS_KEY },
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

  site(host: string, pages: Record<string, K3Route>): this {
    if (!this.dns.has(host)) this.dns.set(host, [K3_PUBLIC_IP]);
    for (const [path, route] of Object.entries(pages)) {
      this.routes.set(`${host}${path}`, route);
    }
    return this;
  }

  html(body: string): K3Route {
    return {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body,
    };
  }

  deps(): PinnedHttpDeps {
    return {
      lookupAll: async (host: string) => {
        this.lookups.push(host);
        const list = this.dns.get(host);
        if (!list) {
          throw Object.assign(new Error(`ENOTFOUND ${host}`), {
            code: 'ENOTFOUND',
          });
        }
        return list.map((address) => ({
          address,
          family: address.includes(':') ? (6 as const) : (4 as const),
        }));
      },
      portOverride: this.port,
      dialOverride: { address: '127.0.0.1', family: 4 },
      tlsCa: K3_TLS_CERT,
      onDial: (host: string, pinned: PinnedAddress) => {
        this.dials.push({ host, address: pinned.address });
      },
    };
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const host = (req.headers.host ?? '').replace(/:\d+$/, '');
    const key = `${host}${req.url ?? '/'}`;
    this.hits.push(key);
    const route = this.routes.get(key) ?? {
      status: 404,
      body: 'not found',
      headers: { 'content-type': 'text/html' },
    };
    res.writeHead(route.status ?? 200, route.headers ?? {});
    res.end(req.method === 'HEAD' ? undefined : (route.body ?? ''));
  }
}
