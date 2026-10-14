/**
 * P-R — инспекция сети в тестах «ноль запросов к Reddit» (AT-RD-11,
 * AT-RD-16): `fetch` и `https.request/get` подменены БРОСАЮЩИМИ функциями,
 * `http.request/get` — тоже, кроме localhost (supertest ходит в тестовое
 * приложение); `net.Socket#connect` и `dns.lookup` — записывающими (база
 * тестов — localhost). `restore()` возвращает оригиналы.
 */
import * as dns from 'dns';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';

export const LOCAL_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '',
  'undefined',
]);

export interface EgressWatch {
  outbound: string[];
  sockets: string[];
  lookups: string[];
  /** Хосты соединений и DNS не к localhost. */
  foreign(): string[];
  restore(): void;
}

export function watchEgress(): EgressWatch {
  const outbound: string[] = [];
  const sockets: string[] = [];
  const lookups: string[] = [];
  const restore: Array<() => void> = [];
  const deny =
    (what: string) =>
    (...args: unknown[]): never => {
      outbound.push(`${what} ${String(args[0])}`);
      throw new Error(`egress запрещён: ${what}`);
    };
  const g = globalThis as { fetch?: unknown };
  const savedFetch = g.fetch;
  g.fetch = deny('fetch');
  restore.push(() => {
    g.fetch = savedFetch;
  });
  for (const fn of ['request', 'get'] as const) {
    const spy = jest
      .spyOn(https, fn)
      .mockImplementation(deny(`https.${fn}`) as never);
    restore.push(() => spy.mockRestore());
    const orig = http[fn];
    const hs = jest.spyOn(http, fn).mockImplementation(((
      ...args: unknown[]
    ) => {
      const a0 = args[0] as string | URL | { hostname?: string; host?: string };
      const host =
        typeof a0 === 'string' || a0 instanceof URL
          ? new URL(String(a0)).hostname
          : String(a0?.hostname ?? a0?.host ?? 'localhost');
      if (!LOCAL_HOSTS.has(host.replace(/^\[|\]$/g, '')))
        return deny(`http.${fn}`)(host);
      return (orig as (...x: unknown[]) => unknown)(...args);
    }) as never);
    restore.push(() => hs.mockRestore());
  }
  const origConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (
    this: net.Socket,
    ...args: unknown[]
  ) {
    const a0 = args[0] as { host?: string; path?: string } | number | string;
    const host =
      typeof a0 === 'object' && a0 !== null
        ? (a0.host ?? (a0.path ? '' : 'localhost'))
        : typeof args[1] === 'string'
          ? args[1]
          : 'localhost';
    sockets.push(String(host));
    return (origConnect as (...x: unknown[]) => net.Socket).apply(this, args);
  } as typeof origConnect;
  restore.push(() => {
    net.Socket.prototype.connect = origConnect;
  });
  const origLookup = dns.lookup;
  (dns as { lookup: unknown }).lookup = (...args: unknown[]) => {
    lookups.push(String(args[0]));
    return (origLookup as (...x: unknown[]) => unknown)(...args);
  };
  restore.push(() => {
    (dns as { lookup: unknown }).lookup = origLookup;
  });
  return {
    outbound,
    sockets,
    lookups,
    foreign: () => [...sockets, ...lookups].filter((h) => !LOCAL_HOSTS.has(h)),
    restore: () => restore.reverse().forEach((r) => r()),
  };
}
