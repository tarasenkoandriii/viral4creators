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
import { createHash } from 'crypto';
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
  /** Пути (`host/path`), где WebSocket принимается по-настоящему. */
  readonly wsPaths = new Set<string>();

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
    // WebSocket (заход 11): попытка соединения записывается как
    // `UPGRADE host/path`; путь из `wsAccept` — настоящее рукопожатие, и
    // каждое текстовое сообщение клиента — `WSMSG host/path текст`
    // (тесту важно, что дошло до сайта); прочие — рвутся.
    this.server.on('upgrade', (req: IncomingMessage, socket: Socket) => {
      const host = (req.headers.host ?? '').replace(/:\d+$/, '');
      const path = (req.url ?? '/').split('?')[0];
      this.hits.push(`UPGRADE ${host}${req.url ?? ''}`);
      const key = req.headers['sec-websocket-key'];
      if (!this.wsPaths.has(`${host}${path}`) || typeof key !== 'string') {
        socket.destroy();
        return;
      }
      const accept = createHash('sha1')
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest('base64');
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      let buf = Buffer.alloc(0);
      socket.on('error', () => undefined);
      socket.on('data', (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        for (;;) {
          if (buf.length < 2) return;
          const op = buf[0] & 0x0f;
          let len = buf[1] & 0x7f;
          let off = 2;
          if (len === 126) {
            if (buf.length < 4) return;
            len = buf.readUInt16BE(2);
            off = 4;
          } else if (len === 127) {
            if (buf.length < 10) return;
            len = Number(buf.readBigUInt64BE(2));
            off = 10;
          }
          const masked = (buf[1] & 0x80) !== 0;
          const need = off + (masked ? 4 : 0) + len;
          if (buf.length < need) return;
          const mask = masked ? buf.subarray(off, off + 4) : null;
          const body = Buffer.from(buf.subarray(need - len, need));
          if (mask)
            for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
          buf = buf.subarray(need);
          if (op === 1)
            this.hits.push(`WSMSG ${host}${path} ${body.toString('utf8')}`);
          if (op === 8) {
            socket.end();
            return;
          }
        }
      });
    });
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

  wsAccept(host: string, path: string): this {
    this.wsPaths.add(`${host}${path}`);
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
