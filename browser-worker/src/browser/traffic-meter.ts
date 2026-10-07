/**
 * Счётчик и потолок трафика задания (Ш3-хвост (9)) — TCP-прослойка между
 * Chromium и фильтрующим прокси задания (`shared/egress-filter-proxy`,
 * общий с бэкендом и реле — его не трогаем):
 *
 *   Chromium ──► счётчик (127.0.0.1:случайный) ──► фильтрующий прокси ──► сеть
 *
 *  - считает байты в обе стороны по каждому соединению браузера;
 *  - потолок трафика задания (`jobBytes`, входящие байты по ВСЕМ
 *    соединениям, включая TLS-тоннели, iframe в своих процессах, воркеры
 *    страниц): превышен — все соединения рвутся, новые отклоняются,
 *    `onJobLimit` (цикл воркера обрывает задание с `traffic_limit`);
 *  - помнит, к какому хосту идёт соединение (первая строка запроса
 *    браузера к прокси — `CONNECT host:443` или абсолютный URL — открытым
 *    текстом), чтобы по сигналу «ответ больше потолка» (его видит
 *    `JobBrowser` по событиям CDP: тело внутри TLS прослойке не видно)
 *    оборвать соединения ЭТОГО хоста (`cutAuthority`).
 *
 * Без адресов в счётчиках: наружу — только числа.
 */
import { connect, createServer, type Server, type Socket } from 'net';
import type { AddressInfo } from 'net';

export interface TrafficLimits {
  /** Тело одного ответа, байты (по распакованным и по сетевым — что больше). */
  responseBytes: number;
  /** Весь входящий трафик задания, байты. */
  jobBytes: number;
}

/** Умолчания: сайт с тяжёлым видео обрежется по ответу, а не по заданию. */
export const DEFAULT_TRAFFIC_LIMITS: Readonly<TrafficLimits> = {
  responseBytes: 20 * 1024 * 1024,
  jobBytes: 150 * 1024 * 1024,
};

export interface TrafficStats {
  /** Входящие байты (сеть → браузер). */
  bytesIn: number;
  /** Исходящие байты (браузер → сеть). */
  bytesOut: number;
  connections: number;
  /** Соединения, отклонённые после потолка задания. */
  refused: number;
  /** Ответы, оборванные по потолку ответа. */
  cutResponses: number;
  /** Задание оборвано по потолку трафика. */
  cutJob: boolean;
}

export interface TrafficMeter {
  /** `http://127.0.0.1:<порт>` — прокси для контекста Chromium. */
  url: string;
  port: number;
  readonly exceeded: boolean;
  stats(): TrafficStats;
  /** Ответ больше потолка: оборвать соединения к `host:port`. */
  cutAuthority(authority: string): number;
  close(): Promise<void>;
}

interface Conn {
  client: Socket;
  upstream: Socket;
  authority: string | null;
}

/** Первая строка запроса браузера к прокси → `host:port` (нижний регистр). */
export function authorityOfRequestLine(head: string): string | null {
  const m = /^([A-Z]+) (\S+) HTTP\/1\.[01]\r?\n/.exec(head);
  if (!m) return null;
  if (m[1] === 'CONNECT') {
    return /^(\[[^\]]+\]|[^:/[\]]+):\d{1,5}$/.test(m[2])
      ? m[2].toLowerCase()
      : null;
  }
  try {
    const u = new URL(m[2]);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return authorityOfUrl(u);
  } catch {
    return null;
  }
}

/** URL → `host:port` в той же форме, что у `authorityOfRequestLine`. */
export function authorityOfUrl(u: URL): string {
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  return `${u.hostname.toLowerCase()}:${port}`;
}

export async function startTrafficMeter(o: {
  /** Порт фильтрующего прокси задания на 127.0.0.1. */
  targetPort: number;
  jobBytes: number;
  onJobLimit?: () => void;
}): Promise<TrafficMeter> {
  const conns = new Set<Conn>();
  const s: TrafficStats = {
    bytesIn: 0,
    bytesOut: 0,
    connections: 0,
    refused: 0,
    cutResponses: 0,
    cutJob: false,
  };
  let closed = false;

  const drop = (c: Conn) => {
    conns.delete(c);
    c.client.destroy();
    c.upstream.destroy();
  };

  const trip = () => {
    if (s.cutJob) return;
    s.cutJob = true;
    for (const c of [...conns]) drop(c);
    try {
      o.onJobLimit?.();
    } catch {
      /* колбэк не должен ронять прослойку */
    }
  };

  const server: Server = createServer((client) => {
    client.on('error', () => undefined);
    if (s.cutJob || closed) {
      s.refused += 1;
      client.destroy();
      return;
    }
    s.connections += 1;
    const upstream = connect(o.targetPort, '127.0.0.1');
    upstream.on('error', () => undefined);
    const c: Conn = { client, upstream, authority: null };
    conns.add(c);
    let head = '';
    // Счётчики — РАНЬШЕ pipe: кусок сверх потолка браузеру уже не уходит.
    client.on('data', (chunk: Buffer) => {
      s.bytesOut += chunk.length;
      if (c.authority === null && head.length < 4096) {
        head += chunk.toString('latin1', 0, Math.min(chunk.length, 4096));
        if (head.includes('\n')) {
          c.authority = authorityOfRequestLine(head) ?? '';
          head = '';
        }
      }
    });
    upstream.on('data', (chunk: Buffer) => {
      s.bytesIn += chunk.length;
      if (s.bytesIn > o.jobBytes) trip();
    });
    client.pipe(upstream);
    upstream.pipe(client);
    client.once('close', () => drop(c));
    upstream.once('close', () => drop(c));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    get exceeded() {
      return s.cutJob;
    },
    stats: () => ({ ...s }),
    cutAuthority(authority: string): number {
      const want = authority.toLowerCase();
      let n = 0;
      for (const c of [...conns]) {
        if (c.authority !== want) continue;
        drop(c);
        n += 1;
      }
      s.cutResponses += 1;
      return n;
    },
    async close() {
      closed = true;
      for (const c of [...conns]) drop(c);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
