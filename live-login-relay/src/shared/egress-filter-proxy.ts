// СГЕНЕРИРОВАНО scripts/sync-relay-shared.mjs — не править.
// Источник: backend/src/common/egress-filter-proxy.ts. Правка — в источнике, затем
// `node scripts/sync-relay-shared.mjs`; CI сверяет копию флагом --check.

/**
 * Фильтрующий forward-прокси для браузера, который открывает ЧУЖИЕ сайты
 * (Э-С, шаг Ш0.2/Ш0.3 — docs-tz/AUDIT-Merge-Assistant-Tutorial-QA-2026-10-02.md,
 * риски К-1 и К-3).
 *
 * ## Зачем
 *
 * Проверка адреса ДО `page.goto` (`assertPubliclyRoutableUrl`) закрывает
 * только сам адрес перехода. Всё, что страница делает дальше, — картинки,
 * `fetch`/XHR, `<iframe>`, WebSocket, попапы, `location = …` — идёт мимо
 * неё. И Chromium резолвит DNS сам, поэтому работает DNS-rebinding:
 * первый ответ публичный (проверка прошла), второй — `10.x` или
 * `169.254.169.254`. Ответ внутреннего адреса попадает в кадр, а кадр —
 * человеку на экран.
 *
 * Прокси ставится между браузером и сетью целиком (`--proxy-server`), и
 * решение принимается на КАЖДОЕ соединение:
 *
 *   1. хост резолвится ОДИН раз, здесь;
 *   2. если хоть один адрес служебный (`isBlockedAddress` — тот же список,
 *      что у фида товаров и у обхода sites-backend) — отказ;
 *   3. соединение открывается на УЖЕ проверенный IP, а не по имени.
 *
 * Пункт 3 и есть защита от rebinding: второго резолва, который мог бы
 * ответить иначе, просто нет. Браузер при HTTP-прокси сам DNS не
 * резолвит — имя хоста уходит прокси в `CONNECT host:443` или в
 * абсолютном URL запроса.
 *
 * ## Чистый модуль
 *
 * Только встроенные модули Node и `./external-url-guard`. Его копия живёт
 * в `live-login-relay/src/shared/` (реле — отдельный Docker build context
 * и сюда дотянуться не может); расхождение копии ловит
 * `node scripts/sync-relay-shared.mjs --check`.
 *
 * ## Чего прокси НЕ закрывает
 *
 * Эксплойт самого Chromium (RCE рендерера при `--no-sandbox`) обходит
 * любой прокси: код в процессе браузера откроет сокет напрямую. От этого
 * защищают обновлённый Chromium (Ш0.4) и сетевой фильтр хоста
 * (`DOCKER-USER`, doc/LIVE-LOGIN-RELAY-EGRESS.md) — прокси их не
 * заменяет, а закрывает то, что делает обычная враждебная СТРАНИЦА.
 */

import { promises as dns } from 'dns';
import {
  createServer,
  request as httpRequest,
  IncomingMessage,
  OutgoingHttpHeaders,
  ServerResponse,
} from 'http';
import { connect as netConnect, isIP, Socket } from 'net';
import { connect as tlsConnect } from 'tls';
import { isBlockedAddress } from './external-url-guard';

/** Вышестоящий прокси (например, резидентный выход реле). */
export interface EgressUpstream {
  protocol: 'http:' | 'https:' | 'socks5:';
  host: string;
  port: number;
  username?: string;
  password?: string;
}

/** Итог решения по одному соединению — для счётчиков, без адресов. */
export type EgressVerdict =
  | 'allowed'
  | 'blocked-address'
  | 'blocked-port'
  | 'bad-request'
  | 'dns-failed'
  | 'connect-failed';

export interface EgressFilterProxyOptions {
  /** Служебный ли адрес. По умолчанию — `isBlockedAddress`. */
  isBlocked?: (ip: string) => boolean;
  /**
   * Дополнительно запрещённые адреса и подсети (`1.2.3.4`, `2a01:4f8::/64`)
   * — публичные адреса САМОГО хоста: они глобальные, и общий список их не
   * ловит, а через них из контейнера видны опубликованные порты хоста.
   */
  denyCidrs?: readonly string[];
  /** Разрешённые порты назначения. По умолчанию — `DEFAULT_ALLOWED_PORTS`. */
  allowedPorts?: readonly number[];
  /** Резолвер; для тестов. По умолчанию — `dns.lookup(all)`. */
  lookup?: (host: string) => Promise<string[]>;
  /** Если задан — проверенный IP открывается ЧЕРЕЗ него (`CONNECT ip:port`). */
  upstream?: EgressUpstream | null;
  connectTimeoutMs?: number;
  /**
   * Потолок одновременных соединений браузера с прокси. Chromium сам
   * держит не больше ~32 сокетов на прокси, но у реле один прокси на
   * все сессии, а враждебная страница может держать ответы вечно —
   * без потолка прокси копил бы сокеты и память до падения процесса.
   */
  maxConnections?: number;
  /** Простой соединения (тоннель или HTTP-ответ), после которого оно
   * закрывается. По умолчанию — `TUNNEL_IDLE_MS`; для тестов. */
  idleTimeoutMs?: number;
  /** Колбэк на каждое решение — счётчики в логе, без URL и адресов. */
  onDecision?: (verdict: EgressVerdict) => void;
}

export interface EgressFilterProxy {
  /** `http://127.0.0.1:<порт>` — для `--proxy-server`. */
  url: string;
  port: number;
  stats(): Record<EgressVerdict, number>;
  close(): Promise<void>;
}

/**
 * Порты назначения по умолчанию. Не «все»: публичный адрес хоста,
 * пропущенный списком (`denyCidrs` не задан), открыл бы странице SSH и
 * панели на нестандартных портах. 8080/8443 — стенды заказчиков за
 * обычным прокси бывают ровно на них.
 */
export const DEFAULT_ALLOWED_PORTS: readonly number[] = [80, 443, 8080, 8443];

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DNS_TIMEOUT_MS = 5_000;
/** Тоннель, по которому ничего не идёт пять минут, — закрываем. */
const TUNNEL_IDLE_MS = 5 * 60_000;
/** См. `maxConnections`: 3–10 браузеров реле × 32 сокета с запасом. */
export const DEFAULT_MAX_CONNECTIONS = 512;

/** Заголовки, которые не пересылаются дальше прокси (RFC 9110 §7.6.1). */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'upgrade',
]);

export class EgressDeniedError extends Error {
  constructor(readonly verdict: EgressVerdict) {
    super(`egress: ${verdict}`);
  }
}

/**
 * Флаги Chromium для работы через прокси.
 *
 * - `--proxy-bypass-list=<-loopback>` — снимает НЕЯВНОЕ исключение:
 *   без него Chromium ходит на `localhost`/`127.0.0.1`/`[::1]` мимо
 *   прокси, и страница достала бы сам процесс реле или бэкенда.
 * - `--force-webrtc-ip-handling-policy=disable_non_proxied_udp` — WebRTC
 *   иначе шлёт UDP (STUN/TURN) напрямую, мимо прокси.
 * - `--disable-quic` — HTTP/3 и WebTransport идут по UDP. Через
 *   HTTP-прокси Chromium QUIC не использует, но флаг убирает саму
 *   возможность UDP-выхода по `Alt-Svc`, не полагаясь на эту деталь
 *   реализации (аудит Ш0 02.10.2026).
 */
export function egressProxyChromiumArgs(proxyUrl: string): string[] {
  return [
    `--proxy-server=${proxyUrl}`,
    '--proxy-bypass-list=<-loopback>',
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--disable-quic',
  ];
}

// ── адреса ───────────────────────────────────────────────────────────

function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/** IPv4 → 32-битное число; `null` — не IPv4. */
function ipv4ToBigInt(ip: string): bigint | null {
  if (isIP(ip) !== 4) return null;
  return ip
    .split('.')
    .reduce((acc, part) => (acc << 8n) | BigInt(Number(part)), 0n);
}

/** IPv6 → 128-битное число; `null` — не IPv6. */
function ipv6ToBigInt(raw: string): bigint | null {
  let ip = stripBrackets(raw);
  const zone = ip.indexOf('%');
  if (zone >= 0) ip = ip.slice(0, zone);
  if (isIP(ip) !== 6) return null;
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (dotted) {
    const v4 = ipv4ToBigInt(dotted[2]);
    if (v4 === null) return null;
    ip = `${dotted[1]}${((v4 >> 16n) & 0xffffn).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const [head, tail] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const groups =
    tail === undefined
      ? h
      : [...h, ...new Array<string>(8 - h.length - t.length).fill('0'), ...t];
  if (groups.length !== 8) return null;
  return groups.reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g, 16)), 0n);
}

export interface Cidr {
  family: 4 | 6;
  base: bigint;
  mask: bigint;
}

/** Разбор `1.2.3.4`, `1.2.3.0/24`, `2a01:4f8::/64`. Кривое — исключение. */
export function parseCidr(spec: string): Cidr {
  const [addr, bitsRaw] = spec.trim().split('/');
  const v4 = ipv4ToBigInt(addr);
  const family: 4 | 6 = v4 !== null ? 4 : 6;
  const value = v4 ?? ipv6ToBigInt(addr);
  const width = family === 4 ? 32 : 128;
  const bits = bitsRaw === undefined ? width : Number(bitsRaw);
  if (
    value === null ||
    !Number.isInteger(bits) ||
    bits < 0 ||
    bits > width ||
    (bitsRaw !== undefined && !/^\d+$/.test(bitsRaw))
  ) {
    throw new Error(`не адрес и не подсеть: ${JSON.stringify(spec)}`);
  }
  const all = (1n << BigInt(width)) - 1n;
  const mask = bits === 0 ? 0n : (all << BigInt(width - bits)) & all;
  return { family, base: value & mask, mask };
}

/** Входит ли адрес в подсеть из `parseCidr` (IPv4, IPv6, `::ffff:a.b.c.d`). */
export function isIpInCidr(ip: string, cidr: Cidr): boolean {
  return inCidr(ip, cidr);
}

function inCidr(ip: string, cidr: Cidr): boolean {
  const value = cidr.family === 4 ? ipv4ToBigInt(ip) : ipv6ToBigInt(ip);
  if (value === null) {
    // IPv4, отображённый в IPv6 (`::ffff:1.2.3.4`), против IPv4-подсети.
    if (cidr.family === 4) {
      const v6 = ipv6ToBigInt(ip);
      if (v6 !== null && v6 >> 32n === 0xffffn) {
        return (v6 & 0xffffffffn & cidr.mask) === cidr.base;
      }
    }
    return false;
  }
  return (value & cidr.mask) === cidr.base;
}

/** Разбор `host:port` из `CONNECT` (IPv6 — в скобках). */
export function parseAuthority(
  authority: string,
): { host: string; port: number } | null {
  const m = /^(\[[^\]]+\]|[^:[\]]+):(\d{1,5})$/.exec(authority.trim());
  if (!m) return null;
  const port = Number(m[2]);
  if (port < 1 || port > 65535) return null;
  return { host: stripBrackets(m[1]), port };
}

async function defaultLookup(host: string): Promise<string[]> {
  const found = await dns.lookup(host, { all: true, verbatim: true });
  return found.map((a) => a.address);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

// ── сам прокси ───────────────────────────────────────────────────────

export async function startEgressFilterProxy(
  options: EgressFilterProxyOptions = {},
): Promise<EgressFilterProxy> {
  const isBlocked = options.isBlocked ?? isBlockedAddress;
  const deny = (options.denyCidrs ?? []).map(parseCidr);
  const ports = new Set(options.allowedPorts ?? DEFAULT_ALLOWED_PORTS);
  const lookup = options.lookup ?? defaultLookup;
  const upstream = options.upstream ?? null;
  const connectTimeoutMs =
    options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const idleMs = options.idleTimeoutMs ?? TUNNEL_IDLE_MS;

  const counters: Record<EgressVerdict, number> = {
    allowed: 0,
    'blocked-address': 0,
    'blocked-port': 0,
    'bad-request': 0,
    'dns-failed': 0,
    'connect-failed': 0,
  };
  const decide = (verdict: EgressVerdict): void => {
    counters[verdict] += 1;
    options.onDecision?.(verdict);
  };

  const addressDenied = (ip: string): boolean =>
    isBlocked(ip) || deny.some((c) => inCidr(ip, c));

  /** Резолв ОДИН раз и проверка ВСЕХ адресов. Возвращает IP для подключения. */
  const pinTarget = async (host: string, port: number): Promise<string> => {
    if (!ports.has(port)) throw new EgressDeniedError('blocked-port');
    const bare = stripBrackets(host);
    let addresses: string[];
    if (isIP(bare)) {
      addresses = [bare];
    } else {
      try {
        addresses = await withTimeout(lookup(bare), DNS_TIMEOUT_MS);
      } catch {
        throw new EgressDeniedError('dns-failed');
      }
    }
    if (addresses.length === 0) throw new EgressDeniedError('dns-failed');
    // Хотя бы один служебный — отказ целиком: какой из адресов выбрал бы
    // клиент сети, заранее не известно (тот же довод, что у
    // `assertPubliclyRoutableUrl`).
    if (addresses.some(addressDenied)) {
      throw new EgressDeniedError('blocked-address');
    }
    return addresses[0];
  };

  const sockets = new Set<Socket>();
  const track = (s: Socket): Socket => {
    sockets.add(s);
    s.once('close', () => sockets.delete(s));
    return s;
  };

  const openTunnel = async (ip: string, port: number): Promise<Socket> => {
    try {
      return track(
        await withTimeout(
          upstream
            ? connectViaUpstream(upstream, ip, port)
            : connectDirect(ip, port),
          connectTimeoutMs,
        ),
      );
    } catch {
      throw new EgressDeniedError('connect-failed');
    }
  };

  const server = createServer((req, res) => {
    void handleRequest(req, res);
  });
  server.maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;

  const handleRequest = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    let url: URL;
    try {
      url = new URL(req.url ?? '');
    } catch {
      decide('bad-request');
      respond(res, 400);
      return;
    }
    if (url.protocol !== 'http:') {
      decide('bad-request');
      respond(res, 400);
      return;
    }
    const port = url.port ? Number(url.port) : 80;
    let socket: Socket;
    try {
      const ip = await pinTarget(url.hostname, port);
      socket = await openTunnel(ip, port);
    } catch (err) {
      const verdict =
        err instanceof EgressDeniedError ? err.verdict : 'connect-failed';
      decide(verdict);
      respond(res, verdict === 'connect-failed' ? 502 : 403);
      return;
    }
    decide('allowed');
    // Браузер ушёл, пока резолвили и подключались, — тоннель некому
    // отдавать (аудит Ш0: без этого сокет жил до таймаута сайта).
    if (req.socket.destroyed) {
      socket.destroy();
      return;
    }
    // Ответ не пришёл или браузер бросил запрос — закрыть и сторону
    // сайта. Раньше сокет к сайту жил, пока сайт сам его не закроет:
    // страница, чей сервер «держит» ответы, копила сокеты в реле
    // (один прокси на все сессии) без ограничения.
    socket.setTimeout(idleMs, () => socket.destroy());
    res.once('close', () => socket.destroy());

    const headers: OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (!HOP_BY_HOP.has(name) && value !== undefined) headers[name] = value;
    }
    // RFC 9112 §3.2.2: при абсолютном URI прокси обязан заменить `Host`
    // адресом из URI. Иначе сайт по проверенному IP получил бы чужой
    // `Host` (`Host: 169.254.169.254`, имя внутренней панели) — для
    // reverse-proxy на этом IP это другой виртуальный хост.
    headers.host = url.host;
    headers.connection = 'close';
    const out = httpRequest({
      method: req.method,
      path: `${url.pathname}${url.search}`,
      headers,
      setHost: false,
      createConnection: () => socket,
    });
    out.on('response', (upstreamRes) => {
      const resHeaders: OutgoingHttpHeaders = {};
      for (const [name, value] of Object.entries(upstreamRes.headers)) {
        if (!HOP_BY_HOP.has(name) && value !== undefined) {
          resHeaders[name] = value;
        }
      }
      res.writeHead(upstreamRes.statusCode ?? 502, resHeaders);
      upstreamRes.pipe(res);
    });
    out.on('error', () => {
      if (!res.headersSent) respond(res, 502);
      else res.destroy();
    });
    req.pipe(out);
  };

  server.on('connect', (req: IncomingMessage, client: Socket, head: Buffer) => {
    track(client);
    client.on('error', () => client.destroy());
    void (async () => {
      const target = parseAuthority(req.url ?? '');
      if (!target) {
        decide('bad-request');
        client.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      let socket: Socket;
      try {
        const ip = await pinTarget(target.host, target.port);
        socket = await openTunnel(ip, target.port);
      } catch (err) {
        const verdict =
          err instanceof EgressDeniedError ? err.verdict : 'connect-failed';
        decide(verdict);
        const status =
          verdict === 'connect-failed' ? '502 Bad Gateway' : '403 Forbidden';
        client.end(
          `HTTP/1.1 ${status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
        );
        return;
      }
      decide('allowed');
      if (client.destroyed) {
        socket.destroy();
        return;
      }
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) socket.write(head);
      splice(client, socket, idleMs);
    })();
  });

  // `ws://` без `CONNECT` (Chromium так не делает, но другой клиент
  // может): то же решение, затем сырой заголовок запроса в тоннель.
  server.on('upgrade', (req: IncomingMessage, client: Socket, head: Buffer) => {
    track(client);
    client.on('error', () => client.destroy());
    void (async () => {
      let url: URL | null = null;
      try {
        url = new URL(req.url ?? '');
      } catch {
        url = null;
      }
      if (!url || (url.protocol !== 'http:' && url.protocol !== 'ws:')) {
        decide('bad-request');
        client.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      const port = url.port ? Number(url.port) : 80;
      let socket: Socket;
      try {
        const ip = await pinTarget(url.hostname, port);
        socket = await openTunnel(ip, port);
      } catch (err) {
        decide(
          err instanceof EgressDeniedError ? err.verdict : 'connect-failed',
        );
        client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      decide('allowed');
      if (client.destroyed) {
        socket.destroy();
        return;
      }
      const lines = [`${req.method} ${url.pathname}${url.search} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i];
        const lower = name.toLowerCase();
        if (lower.startsWith('proxy-') || lower === 'host') continue;
        lines.push(`${name}: ${req.rawHeaders[i + 1]}`);
      }
      // `Host` — из URI, как и в обычном запросе (RFC 9112 §3.2.2).
      lines.splice(1, 0, `Host: ${url.host}`);
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head.length) socket.write(head);
      splice(client, socket, idleMs);
    })();
  });

  server.on('clientError', (_err, socket) => {
    socket.destroy();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    stats: () => ({ ...counters }),
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

function respond(res: ServerResponse, status: number): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, { 'content-length': '0', connection: 'close' });
  res.end();
}

function splice(a: Socket, b: Socket, idleMs: number): void {
  a.setTimeout(idleMs, () => a.destroy());
  b.setTimeout(idleMs, () => b.destroy());
  a.on('error', () => b.destroy());
  b.on('error', () => a.destroy());
  a.on('close', () => b.destroy());
  b.on('close', () => a.destroy());
  a.pipe(b);
  b.pipe(a);
}

function connectDirect(ip: string, port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = netConnect({ host: ip, port });
    s.once('connect', () => {
      s.off('error', reject);
      resolve(s);
    });
    s.once('error', reject);
  });
}

/** Соединение с вышестоящим прокси (TCP или TLS). */
function connectToUpstream(upstream: EgressUpstream): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s =
      upstream.protocol === 'https:'
        ? tlsConnect({
            host: upstream.host,
            port: upstream.port,
            servername: isIP(upstream.host) ? undefined : upstream.host,
          })
        : netConnect({ host: upstream.host, port: upstream.port });
    const ready = upstream.protocol === 'https:' ? 'secureConnect' : 'connect';
    s.once(ready, () => {
      s.off('error', reject);
      resolve(s);
    });
    s.once('error', reject);
  });
}

/** Читает из сокета, пока `done` не скажет, сколько байт — его. */
function readUntil(
  s: Socket,
  done: (buf: Buffer) => number | null,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > 16 * 1024) {
        cleanup();
        reject(new Error('слишком длинный ответ прокси'));
        return;
      }
      const used = done(buf);
      if (used === null) return;
      cleanup();
      if (used < buf.length) s.unshift(buf.subarray(used));
      resolve(buf.subarray(0, used));
    };
    const onEnd = (): void => {
      cleanup();
      reject(new Error('прокси закрыл соединение'));
    };
    const cleanup = (): void => {
      s.off('data', onData);
      s.off('end', onEnd);
      s.off('error', onEnd);
    };
    s.on('data', onData);
    s.once('end', onEnd);
    s.once('error', onEnd);
  });
}

/**
 * Тоннель к УЖЕ проверенному IP через вышестоящий прокси: `CONNECT ip:port`
 * (HTTP/HTTPS) или SOCKS5 с адресом-IP. Имя хоста дальше не уходит —
 * вышестоящий не резолвит заново, rebinding закрыт и здесь. TLS к сайту
 * Chromium делает внутри тоннеля сам, с правильным SNI.
 */
export async function connectViaUpstream(
  upstream: EgressUpstream,
  ip: string,
  port: number,
): Promise<Socket> {
  const s = await connectToUpstream(upstream);
  try {
    if (upstream.protocol === 'socks5:') {
      await socks5Handshake(s, upstream, ip, port);
    } else {
      const authority = isIP(ip) === 6 ? `[${ip}]:${port}` : `${ip}:${port}`;
      const auth = upstream.username
        ? `Proxy-Authorization: Basic ${Buffer.from(
            `${upstream.username}:${upstream.password ?? ''}`,
          ).toString('base64')}\r\n`
        : '';
      s.write(
        `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${auth}\r\n`,
      );
      const head = await readUntil(s, (buf) => {
        const end = buf.indexOf('\r\n\r\n');
        return end < 0 ? null : end + 4;
      });
      const status = /^HTTP\/1\.[01] (\d{3})/.exec(head.toString('latin1'));
      if (!status || status[1] !== '200') {
        throw new Error(`вышестоящий прокси ответил ${status?.[1] ?? '?'}`);
      }
    }
    return s;
  } catch (err) {
    s.destroy();
    throw err;
  }
}

async function socks5Handshake(
  s: Socket,
  upstream: EgressUpstream,
  ip: string,
  port: number,
): Promise<void> {
  const withAuth = Boolean(upstream.username);
  s.write(Buffer.from(withAuth ? [5, 1, 2] : [5, 1, 0]));
  const choice = await readUntil(s, (b) => (b.length >= 2 ? 2 : null));
  if (choice[0] !== 5 || choice[1] !== (withAuth ? 2 : 0)) {
    throw new Error('SOCKS5: метод аутентификации не принят');
  }
  if (withAuth) {
    const user = Buffer.from(upstream.username ?? '');
    const pass = Buffer.from(upstream.password ?? '');
    s.write(
      Buffer.concat([
        Buffer.from([1, user.length]),
        user,
        Buffer.from([pass.length]),
        pass,
      ]),
    );
    const auth = await readUntil(s, (b) => (b.length >= 2 ? 2 : null));
    if (auth[1] !== 0) throw new Error('SOCKS5: неверные учётные данные');
  }
  const v6 = isIP(ip) === 6;
  const addr = v6
    ? Buffer.from(
        (ipv6ToBigInt(ip) ?? 0n).toString(16).padStart(32, '0'),
        'hex',
      )
    : Buffer.from(ip.split('.').map(Number));
  const portBuf = Buffer.from([(port >> 8) & 0xff, port & 0xff]);
  s.write(Buffer.concat([Buffer.from([5, 1, 0, v6 ? 4 : 1]), addr, portBuf]));
  // Ответ: VER REP RSV ATYP BND.ADDR BND.PORT — длина зависит от ATYP.
  const reply = await readUntil(s, (b) => {
    if (b.length < 5) return null;
    const len = b[3] === 1 ? 4 : b[3] === 4 ? 16 : b[3] === 3 ? 1 + b[4] : -1;
    if (len < 0) return 4;
    return b.length >= 4 + len + 2 ? 4 + len + 2 : null;
  });
  if (reply[1] !== 0) throw new Error(`SOCKS5: отказ ${reply[1]}`);
}
