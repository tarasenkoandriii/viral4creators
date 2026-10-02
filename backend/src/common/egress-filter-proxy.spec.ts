/**
 * Фильтрующий прокси браузера (Ш0.2/Ш0.3, риски К-1/К-3 аудита
 * 02.10.2026). Тесты — на настоящих сокетах 127.0.0.1: проверяется то,
 * что видит браузер (`CONNECT`, абсолютный URL, `Upgrade`), а не
 * внутренние функции.
 *
 * Сайт-цель в тестах — локальный сервер. Чтобы до него вообще можно было
 * дойти, тесты «положительного» пути подменяют `isBlocked`: loopback
 * считается публичным, остальной список — настоящий. Тесты «отказа»
 * идут и с настоящим `isBlockedAddress`.
 */

import { createServer, Server } from 'http';
import { AddressInfo, connect, createServer as createTcpServer } from 'net';
import { isBlockedAddress } from './external-url-guard';
import {
  EgressFilterProxy,
  EgressVerdict,
  egressProxyChromiumArgs,
  parseAuthority,
  parseCidr,
  startEgressFilterProxy,
} from './egress-filter-proxy';

/** «Публичный» для тестов: loopback разрешён, остальное — как в проде. */
const testIsBlocked = (ip: string): boolean =>
  ip === '127.0.0.1' ? false : isBlockedAddress(ip);

let target: Server;
let targetPort: number;
const targetHits: string[] = [];

beforeAll(async () => {
  target = createServer((req, res) => {
    targetHits.push(`${req.method} ${req.url} host=${req.headers.host}`);
    res.writeHead(200, { 'content-type': 'text/plain', 'x-from': 'target' });
    res.end('secret-internal-page');
  });
  target.on('upgrade', (req, socket) => {
    targetHits.push(`UPGRADE ${req.url}`);
    socket.end(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
    );
  });
  await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
  targetPort = (target.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((r) => target.close(() => r()));
});

let proxy: EgressFilterProxy | null = null;
beforeEach(() => {
  targetHits.length = 0;
});
afterEach(async () => {
  await proxy?.close();
  proxy = null;
});

/** Сырой запрос к прокси; ответ целиком — до закрытия соединения. */
function raw(port: number, text: string, waitMs = 3000): Promise<string> {
  return new Promise((resolve) => {
    const s = connect(port, '127.0.0.1');
    let out = '';
    const timer = setTimeout(() => {
      s.destroy();
      resolve(out);
    }, waitMs);
    s.on('data', (d) => {
      out += d.toString('latin1');
    });
    s.on('close', () => {
      clearTimeout(timer);
      resolve(out);
    });
    s.on('error', () => undefined);
    s.write(text);
  });
}

function connectThenGet(host: string, port: number): string {
  return (
    `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n` +
    `GET /admin HTTP/1.1\r\nHost: ${host}:${port}\r\nConnection: close\r\n\r\n`
  );
}

describe('startEgressFilterProxy — разрешённый путь', () => {
  it('CONNECT к публичному хосту: тоннель открыт, сайт ответил', async () => {
    const lookup = jest.fn(async () => ['127.0.0.1']);
    proxy = await startEgressFilterProxy({
      isBlocked: testIsBlocked,
      lookup,
      allowedPorts: [targetPort],
    });
    const out = await raw(proxy.port, connectThenGet('site.test', targetPort));
    expect(out).toMatch(/^HTTP\/1\.1 200 Connection Established/);
    expect(out).toContain('secret-internal-page');
    expect(proxy.stats().allowed).toBe(1);
  });

  it('IP-pin: подключение идёт на проверенный IP, имя второй раз не резолвится (rebinding)', async () => {
    // `rebind.test` системный DNS не знает вовсе. Если бы прокси
    // подключался по ИМЕНИ (второй резолв — тот, что у rebinding отдаёт
    // 10.x), соединение не открылось бы. Ответ сайта доказывает, что
    // ушли на адрес из ЕДИНСТВЕННОГО проверенного резолва.
    let calls = 0;
    const lookup = jest.fn(async () => {
      calls += 1;
      return calls === 1 ? ['127.0.0.1'] : ['10.0.0.1'];
    });
    proxy = await startEgressFilterProxy({
      isBlocked: testIsBlocked,
      lookup,
      allowedPorts: [targetPort],
    });
    const out = await raw(
      proxy.port,
      `GET http://rebind.test:${targetPort}/x HTTP/1.1\r\nHost: rebind.test:${targetPort}\r\nConnection: close\r\n\r\n`,
    );
    expect(out).toMatch(/^HTTP\/1\.1 200/);
    expect(out).toContain('secret-internal-page');
    expect(lookup).toHaveBeenCalledTimes(1);
    // Host сайта сохраняется — виртуальный хостинг продолжает работать.
    expect(targetHits).toEqual([`GET /x host=rebind.test:${targetPort}`]);
  });

  it('следующее соединение резолвится заново — и отказ, если адрес стал внутренним', async () => {
    let calls = 0;
    const lookup = jest.fn(async () => {
      calls += 1;
      return calls === 1 ? ['127.0.0.1'] : ['10.0.0.1'];
    });
    proxy = await startEgressFilterProxy({
      isBlocked: testIsBlocked,
      lookup,
      allowedPorts: [targetPort],
    });
    await raw(proxy.port, connectThenGet('flip.test', targetPort));
    const second = await raw(
      proxy.port,
      connectThenGet('flip.test', targetPort),
    );
    expect(second).toMatch(/^HTTP\/1\.1 403/);
    expect(proxy.stats()['blocked-address']).toBe(1);
  });

  it('ws:// через Upgrade без CONNECT — тот же фильтр, затем 101 от сайта', async () => {
    proxy = await startEgressFilterProxy({
      isBlocked: testIsBlocked,
      lookup: async () => ['127.0.0.1'],
      allowedPorts: [targetPort],
    });
    const out = await raw(
      proxy.port,
      `GET http://ws.test:${targetPort}/socket HTTP/1.1\r\nHost: ws.test:${targetPort}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nProxy-Authorization: Basic eDp5\r\n\r\n`,
    );
    expect(out).toMatch(/^HTTP\/1\.1 101/);
    expect(targetHits).toEqual(['UPGRADE /socket']);
  });
});

describe('startEgressFilterProxy — отказы (настоящий isBlockedAddress)', () => {
  const decisions: EgressVerdict[] = [];
  beforeEach(() => {
    decisions.length = 0;
  });

  it.each([
    ['метаданные облака', '169.254.169.254', 80],
    ['loopback', '127.0.0.1', 443],
    ['сеть Docker', '172.18.0.3', 443],
    ['RFC1918', '10.0.0.7', 8080],
    ['IPv6 loopback', '[::1]', 443],
    ['IPv6 ULA', '[fd00::1]', 443],
    ['NAT64 на приватный', '[64:ff9b::a00:1]', 443],
  ])('CONNECT на %s (%s) — 403', async (_name, host, port) => {
    proxy = await startEgressFilterProxy({
      onDecision: (v) => decisions.push(v),
    });
    const out = await raw(proxy.port, connectThenGet(host, port));
    expect(out).toMatch(/^HTTP\/1\.1 403/);
    expect(decisions).toEqual(['blocked-address']);
  });

  it('имя, резолвящееся во внутренний адрес, — 403 (сайт не трогается)', async () => {
    proxy = await startEgressFilterProxy({
      lookup: async () => ['127.0.0.1'],
      allowedPorts: [targetPort],
    });
    const out = await raw(proxy.port, connectThenGet('localhost', targetPort));
    expect(out).toMatch(/^HTTP\/1\.1 403/);
    expect(targetHits).toEqual([]);
  });

  it('хотя бы один служебный адрес среди ответов DNS — отказ целиком', async () => {
    proxy = await startEgressFilterProxy({
      lookup: async () => ['93.184.216.34', '10.0.0.5'],
      onDecision: (v) => decisions.push(v),
    });
    const out = await raw(proxy.port, connectThenGet('mixed.test', 443));
    expect(out).toMatch(/^HTTP\/1\.1 403/);
    expect(decisions).toEqual(['blocked-address']);
  });

  it('абсолютный http://-запрос на внутренний адрес — 403 и ни байта наружу', async () => {
    proxy = await startEgressFilterProxy({
      onDecision: (v) => decisions.push(v),
    });
    const out = await raw(
      proxy.port,
      `GET http://127.0.0.1:${targetPort}/ HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`,
    );
    expect(out).toMatch(/^HTTP\/1\.1 403/);
    expect(targetHits).toEqual([]);
  });

  it('публичный адрес самого хоста из denyCidrs — 403 (IPv4 и IPv6 /64)', async () => {
    proxy = await startEgressFilterProxy({
      denyCidrs: ['203.0.114.0/24', '2a01:4f8:1:2::/64'],
      lookup: async (h) =>
        h === 'v4.test' ? ['203.0.114.7'] : ['2a01:4f8:1:2::5'],
      onDecision: (v) => decisions.push(v),
    });
    expect(await raw(proxy.port, connectThenGet('v4.test', 443))).toMatch(
      /^HTTP\/1\.1 403/,
    );
    expect(await raw(proxy.port, connectThenGet('v6.test', 443))).toMatch(
      /^HTTP\/1\.1 403/,
    );
    expect(decisions).toEqual(['blocked-address', 'blocked-address']);
  });

  it('порт вне списка (SSH хоста) — 403 без резолва', async () => {
    const lookup = jest.fn(async () => ['93.184.216.34']);
    proxy = await startEgressFilterProxy({
      lookup,
      onDecision: (v) => decisions.push(v),
    });
    const out = await raw(proxy.port, connectThenGet('site.test', 22));
    expect(out).toMatch(/^HTTP\/1\.1 403/);
    expect(decisions).toEqual(['blocked-port']);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('DNS не ответил — 403 dns-failed', async () => {
    proxy = await startEgressFilterProxy({
      lookup: async () => {
        throw new Error('ENOTFOUND');
      },
      onDecision: (v) => decisions.push(v),
    });
    const out = await raw(proxy.port, connectThenGet('nx.test', 443));
    expect(out).toMatch(/^HTTP\/1\.1 403/);
    expect(decisions).toEqual(['dns-failed']);
  });

  it('кривой CONNECT и https:// в абсолютном URL — 400', async () => {
    proxy = await startEgressFilterProxy({
      onDecision: (v) => decisions.push(v),
    });
    expect(
      await raw(proxy.port, 'CONNECT no-port HTTP/1.1\r\nHost: x\r\n\r\n'),
    ).toMatch(/^HTTP\/1\.1 400/);
    expect(
      await raw(
        proxy.port,
        'GET https://site.test/ HTTP/1.1\r\nHost: site.test\r\n\r\n',
      ),
    ).toMatch(/^HTTP\/1\.1 400/);
    expect(decisions).toEqual(['bad-request', 'bad-request']);
  });
});

describe('вышестоящий прокси (резидентный выход реле)', () => {
  it('HTTP-upstream получает CONNECT на проверенный IP, а не имя, с Proxy-Authorization', async () => {
    const seen: string[] = [];
    const upstream = createTcpServer((sock) => {
      sock.once('data', (d) => {
        const head = d.toString('latin1');
        seen.push(head.split('\r\n\r\n')[0]);
        const target = connect(targetPort, '127.0.0.1', () => {
          sock.write('HTTP/1.1 200 OK\r\n\r\n');
          const rest = d.subarray(d.indexOf('\r\n\r\n') + 4);
          if (rest.length) target.write(rest);
          sock.pipe(target).pipe(sock);
        });
      });
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
    try {
      proxy = await startEgressFilterProxy({
        isBlocked: testIsBlocked,
        lookup: async () => ['127.0.0.1'],
        allowedPorts: [targetPort],
        upstream: {
          protocol: 'http:',
          host: '127.0.0.1',
          port: (upstream.address() as AddressInfo).port,
          username: 'user',
          password: 'p@ss',
        },
      });
      const out = await raw(
        proxy.port,
        connectThenGet('shop.test', targetPort),
      );
      expect(out).toContain('secret-internal-page');
      expect(seen[0]).toContain(`CONNECT 127.0.0.1:${targetPort} HTTP/1.1`);
      expect(seen[0]).not.toContain('shop.test');
      expect(seen[0]).toContain(
        `Proxy-Authorization: Basic ${Buffer.from('user:p@ss').toString('base64')}`,
      );
    } finally {
      upstream.close();
    }
  });

  it('SOCKS5-upstream получает адрес типа IPv4 (ATYP=1), с логином', async () => {
    const seen: number[][] = [];
    const upstream = createTcpServer((sock) => {
      let stage = 0;
      sock.on('data', (d) => {
        if (stage === 0) {
          stage = 1;
          sock.write(Buffer.from([5, 2]));
        } else if (stage === 1) {
          stage = 2;
          sock.write(Buffer.from([1, 0]));
        } else if (stage === 2) {
          stage = 3;
          seen.push([...d]);
          const target = connect(targetPort, '127.0.0.1', () => {
            sock.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
            sock.removeAllListeners('data');
            sock.pipe(target).pipe(sock);
          });
        }
      });
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
    try {
      proxy = await startEgressFilterProxy({
        isBlocked: testIsBlocked,
        lookup: async () => ['127.0.0.1'],
        allowedPorts: [targetPort],
        upstream: {
          protocol: 'socks5:',
          host: '127.0.0.1',
          port: (upstream.address() as AddressInfo).port,
          username: 'u',
          password: 'p',
        },
      });
      const out = await raw(
        proxy.port,
        connectThenGet('shop.test', targetPort),
      );
      expect(out).toContain('secret-internal-page');
      expect(seen[0].slice(0, 8)).toEqual([5, 1, 0, 1, 127, 0, 0, 1]);
    } finally {
      upstream.close();
    }
  });
});

describe('вспомогательное', () => {
  it('флаги Chromium снимают неявный обход loopback, прямой UDP WebRTC и QUIC', () => {
    expect(egressProxyChromiumArgs('http://127.0.0.1:1234')).toEqual([
      '--proxy-server=http://127.0.0.1:1234',
      '--proxy-bypass-list=<-loopback>',
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--disable-quic',
    ]);
  });

  it('parseAuthority: IPv6 в скобках, порт обязателен', () => {
    expect(parseAuthority('[::1]:443')).toEqual({ host: '::1', port: 443 });
    expect(parseAuthority('a.test:80')).toEqual({ host: 'a.test', port: 80 });
    expect(parseAuthority('a.test')).toBeNull();
    expect(parseAuthority('a.test:70000')).toBeNull();
  });

  it('parseCidr: кривое значение — исключение, а не «пустой» фильтр', () => {
    expect(() => parseCidr('не-адрес')).toThrow();
    expect(() => parseCidr('10.0.0.0/33')).toThrow();
    expect(() => parseCidr('10.0.0.0/x')).toThrow();
    expect(parseCidr('10.1.2.3/8').base).toBe(10n << 24n);
  });
});

// ── аудит Ш0 02.10.2026: обходы записи адреса и ресурсы прокси ──────────

describe('аудит Ш0: IP в нестандартной записи и обёртки IPv6 (настоящий резолвер)', () => {
  it.each([
    ['десятичная запись loopback', '2130706433', 443],
    ['шестнадцатеричная запись', '0x7f.1', 443],
    ['восьмеричная запись', '0177.0.0.1', 443],
    ['«0» — это 0.0.0.0, на Linux = localhost', '0', 443],
    ['0.0.0.0', '0.0.0.0', 80],
    ['IPv4-mapped hex', '[::ffff:7f00:1]', 443],
    ['IPv4-mapped dotted', '[::ffff:169.254.169.254]', 80],
    ['IPv6 unspecified', '[::]', 443],
    ['6to4 c loopback внутри', '[2002:7f00:1::1]', 443],
    ['IPv4-compatible', '[::127.0.0.1]', 443],
    ['link-local с зоной', '[fe80::1%25eth0]', 443],
  ])('CONNECT: %s (%s) — 403', async (_name, host, port) => {
    const decisions: EgressVerdict[] = [];
    proxy = await startEgressFilterProxy({
      onDecision: (v) => decisions.push(v),
    });
    const out = await raw(proxy.port, connectThenGet(host, port));
    expect(out).toMatch(/^HTTP\/1\.1 (403|400)/);
    expect(decisions).not.toContain('allowed');
  });

  it('абсолютный URI с десятичным IP — 403, сайт не тронут', async () => {
    proxy = await startEgressFilterProxy({ allowedPorts: [targetPort] });
    const out = await raw(
      proxy.port,
      `GET http://2130706433:${targetPort}/ HTTP/1.1\r\nHost: site.test\r\n\r\n`,
    );
    expect(out).toMatch(/^HTTP\/1\.1 403/);
    expect(targetHits).toEqual([]);
  });
});

describe('аудит Ш0: Host и ресурсы', () => {
  it('абсолютный URI: Host берётся из URI, а не из заголовка клиента (RFC 9112 §3.2.2)', async () => {
    proxy = await startEgressFilterProxy({
      isBlocked: testIsBlocked,
      lookup: async () => ['127.0.0.1'],
      allowedPorts: [targetPort],
    });
    const out = await raw(
      proxy.port,
      `GET http://site.test:${targetPort}/x HTTP/1.1\r\nHost: 169.254.169.254\r\nConnection: close\r\n\r\n`,
    );
    expect(out).toMatch(/^HTTP\/1\.1 200/);
    expect(targetHits).toEqual([`GET /x host=site.test:${targetPort}`]);
  });

  it('ws:// Upgrade: Host тоже из URI', async () => {
    proxy = await startEgressFilterProxy({
      isBlocked: testIsBlocked,
      lookup: async () => ['127.0.0.1'],
      allowedPorts: [targetPort],
    });
    const seenHost: string[] = [];
    const onUpgrade = (req: { rawHeaders: string[] }) => {
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        if (req.rawHeaders[i].toLowerCase() === 'host') {
          seenHost.push(req.rawHeaders[i + 1]);
        }
      }
    };
    target.on('upgrade', onUpgrade);
    try {
      await raw(
        proxy.port,
        `GET ws://site.test:${targetPort}/s HTTP/1.1\r\nHost: 10.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
        1000,
      );
    } finally {
      target.off('upgrade', onUpgrade);
    }
    expect(seenHost).toEqual([`site.test:${targetPort}`]);
  });

  /** Сайт, который принимает соединение и молчит; считает закрытия. */
  async function silentSite(): Promise<{
    port: number;
    open: () => number;
    close: () => Promise<void>;
  }> {
    const socks = new Set<import('net').Socket>();
    const srv = createTcpServer((s) => {
      socks.add(s);
      s.on('close', () => socks.delete(s));
      s.on('error', () => undefined);
      // Читать (и выбрасывать): поток на паузе не видит FIN и не узнал
      // бы, что прокси закрыл соединение.
      s.resume();
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    return {
      port: (srv.address() as AddressInfo).port,
      open: () => socks.size,
      close: () =>
        new Promise<void>((r) => {
          for (const s of socks) s.destroy();
          srv.close(() => r());
        }),
    };
  }

  const waitFor = async (cond: () => boolean, ms = 2000): Promise<boolean> => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (cond()) return true;
      await new Promise((r) => setTimeout(r, 20));
    }
    return cond();
  };

  it('браузер бросил HTTP-запрос — сокет к сайту закрывается сразу, а не «когда сайт захочет»', async () => {
    const site = await silentSite();
    try {
      proxy = await startEgressFilterProxy({
        isBlocked: testIsBlocked,
        lookup: async () => ['127.0.0.1'],
        allowedPorts: [site.port],
      });
      const c = connect(proxy.port, '127.0.0.1');
      c.on('error', () => undefined);
      c.write(
        `GET http://slow.test:${site.port}/ HTTP/1.1\r\nHost: slow.test\r\n\r\n`,
      );
      expect(await waitFor(() => site.open() === 1)).toBe(true);
      c.destroy();
      expect(await waitFor(() => site.open() === 0)).toBe(true);
    } finally {
      await site.close();
    }
  });

  it('HTTP-ответ, который не идёт, закрывается по простою', async () => {
    const site = await silentSite();
    try {
      proxy = await startEgressFilterProxy({
        isBlocked: testIsBlocked,
        lookup: async () => ['127.0.0.1'],
        allowedPorts: [site.port],
        idleTimeoutMs: 150,
      });
      const out = raw(
        proxy.port,
        `GET http://slow.test:${site.port}/ HTTP/1.1\r\nHost: slow.test\r\n\r\n`,
        3000,
      );
      expect(await waitFor(() => site.open() === 1)).toBe(true);
      expect(await waitFor(() => site.open() === 0, 1500)).toBe(true);
      expect(await out).toMatch(/^HTTP\/1\.1 502/);
    } finally {
      await site.close();
    }
  });

  it('CONNECT-тоннель без трафика закрывается по простою', async () => {
    const site = await silentSite();
    try {
      proxy = await startEgressFilterProxy({
        isBlocked: testIsBlocked,
        lookup: async () => ['127.0.0.1'],
        allowedPorts: [site.port],
        idleTimeoutMs: 150,
      });
      const started = Date.now();
      const out = await raw(
        proxy.port,
        `CONNECT slow.test:${site.port} HTTP/1.1\r\nHost: x\r\n\r\n`,
        3000,
      );
      expect(out).toMatch(/^HTTP\/1\.1 200/);
      expect(Date.now() - started).toBeLessThan(2000);
      expect(await waitFor(() => site.open() === 0)).toBe(true);
    } finally {
      await site.close();
    }
  });

  it('потолок соединений: лишнее соединение закрывается, не дойдя до резолва', async () => {
    const site = await silentSite();
    try {
      const lookup = jest.fn(async () => ['127.0.0.1']);
      proxy = await startEgressFilterProxy({
        isBlocked: testIsBlocked,
        lookup,
        allowedPorts: [site.port],
        maxConnections: 1,
      });
      const first = connect(proxy.port, '127.0.0.1');
      first.on('error', () => undefined);
      first.write(`CONNECT slow.test:${site.port} HTTP/1.1\r\nHost: x\r\n\r\n`);
      expect(await waitFor(() => site.open() === 1)).toBe(true);
      const second = await raw(
        proxy.port,
        `CONNECT slow.test:${site.port} HTTP/1.1\r\nHost: x\r\n\r\n`,
        1000,
      );
      expect(second).toBe('');
      expect(lookup).toHaveBeenCalledTimes(1);
      first.destroy();
    } finally {
      await site.close();
    }
  });
});
