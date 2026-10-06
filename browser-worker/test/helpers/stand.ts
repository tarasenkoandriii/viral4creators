/**
 * Стенды e2e воркера: https-сайт на 127.0.0.1 («сайт заказчика») и
 * «интернет» — вышестоящий CONNECT-прокси, через который фильтрующий
 * прокси воркера ходит наружу (`upstream`). Имена резолвятся подменой DNS
 * воркера в «публичный» адрес (проверка блок-листа — настоящая), а
 * «интернет» соединяет любой разрешённый публичный адрес со стендом.
 * Всё, что дошло до стенда и «интернета», записывается: тест видит, что
 * запрещённое НЕ ушло из воркера.
 */
import { createServer as createHttps, type Server as HttpsServer } from 'https';
import {
  createServer as createHttp,
  type IncomingMessage,
  type ServerResponse,
} from 'http';
import { connect, type AddressInfo, type Socket } from 'net';
import { STAND_CERT, STAND_KEY } from './tls';

/** Публичный адрес-заглушка (example.com), в который резолвятся имена стенда. */
export const PUBLIC_TEST_IP = '93.184.216.34';

export type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  body: string,
) => void;

export class Stand {
  private server: HttpsServer | null = null;
  port = 0;
  readonly routes = new Map<string, Handler>();
  readonly hits: string[] = [];

  async start(): Promise<this> {
    this.server = createHttps(
      { cert: STAND_CERT, key: STAND_KEY },
      (req, res) => {
        let body = '';
        req.on('data', (c: Buffer) => (body += c.toString('utf8')));
        req.on('end', () => {
          const host = (req.headers.host ?? '').replace(/:\d+$/, '');
          const path = (req.url ?? '/').split('?')[0];
          this.hits.push(`${req.method} ${host}${req.url ?? ''}`);
          const h = this.routes.get(`${host}${path}`);
          if (!h) {
            res.writeHead(404, { 'content-type': 'text/html' });
            res.end('<!doctype html><title>404</title><h1>Не знайдено</h1>');
            return;
          }
          h(req, res, body);
        });
      },
    );
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    this.port = (this.server.address() as AddressInfo).port;
    return this;
  }

  page(
    host: string,
    path: string,
    html: string,
    headers: Record<string, string> = {},
  ): this {
    this.routes.set(`${host}${path}`, (_q, res) => {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        ...headers,
      });
      res.end(html);
    });
    return this;
  }

  on(host: string, path: string, h: Handler): this {
    this.routes.set(`${host}${path}`, h);
    return this;
  }

  hit(fragment: string): boolean {
    return this.hits.some((h) => h.includes(fragment));
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server!.close(() => r()));
    this.server = null;
  }
}

/** «Интернет»: CONNECT <публичный IP>:443 → стенд; прочее — отказ. */
export class FakeInternet {
  private server = createHttp((_q, res) => {
    res.writeHead(405);
    res.end();
  });
  port = 0;
  readonly dials: string[] = [];
  private readonly sockets = new Set<Socket>();

  constructor(private readonly stand: Stand) {}

  async start(): Promise<this> {
    this.server.on('connect', (req, client: Socket) => {
      const target = req.url ?? '';
      this.dials.push(target);
      this.sockets.add(client);
      client.on('close', () => this.sockets.delete(client));
      client.on('error', () => undefined);
      const [ip, port] = target.split(':');
      if (ip !== PUBLIC_TEST_IP || port !== '443') {
        client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
        return;
      }
      const up = connect(this.stand.port, '127.0.0.1', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        up.pipe(client);
        client.pipe(up);
      });
      this.sockets.add(up);
      up.on('close', () => this.sockets.delete(up));
      up.on('error', () => client.destroy());
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.port = (this.server.address() as AddressInfo).port;
    return this;
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}
