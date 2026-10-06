/**
 * Фильтр исходящего трафика браузера воркера (копия Ш0 —
 * `shared/egress-filter-proxy.ts`) на локальных сокетах: приватные адреса,
 * метаданные облака, адрес самого сервера, чужой порт — отказ до любого
 * подключения; DNS-rebinding — адрес резолвится один раз на соединение и
 * подключение идёт на проверенный IP.
 */
import { request } from 'http';
import {
  connect as netConnect,
  createServer,
  type AddressInfo,
  type Server,
} from 'net';
import { startEgressFilterProxy } from '../../src/shared/egress-filter-proxy';

function connectVia(proxyPort: number, target: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port: proxyPort,
      method: 'CONNECT',
      path: target,
    });
    req.on('connect', (res, socket) => {
      socket.destroy();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

describe('фильтр исходящего трафика воркера', () => {
  let upstream: Server;
  let upPort = 0;
  const dialed: string[] = [];

  beforeAll(async () => {
    // «Интернет»: принимает CONNECT и записывает, куда просили.
    upstream = createServer((s) => {
      s.once('data', (b) => {
        const line = b.toString('utf8').split('\r\n')[0];
        dialed.push(line.split(' ')[1]);
        s.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        s.end();
      });
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
    upPort = (upstream.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => upstream.close(() => r())));

  it('частные, служебные, метаданные облака, адрес сервера, чужой порт — 403 без подключения', async () => {
    const dns: Record<string, string[]> = {
      'private.test': ['10.1.2.3'],
      'meta.test': ['169.254.169.254'],
      'mixed.test': ['93.184.216.34', '192.168.1.1'],
      'self.test': ['203.0.113.7'],
      'v6.test': ['::ffff:127.0.0.1'],
      'ok.test': ['93.184.216.34'],
    };
    const proxy = await startEgressFilterProxy({
      denyCidrs: ['203.0.113.7/32'],
      allowedPorts: [80, 443],
      lookup: async (h) => dns[h] ?? [],
      upstream: { protocol: 'http:', host: '127.0.0.1', port: upPort },
    });
    try {
      for (const t of [
        'private.test:443',
        'meta.test:443',
        '169.254.169.254:80',
        'mixed.test:443',
        'self.test:443',
        'v6.test:443',
        '[::1]:443',
        'ok.test:22',
      ]) {
        expect([t, await connectVia(proxy.port, t)]).toEqual([t, 403]);
      }
      expect(dialed).toEqual([]);
      expect(await connectVia(proxy.port, 'ok.test:443')).toBe(200);
      expect(dialed).toEqual(['93.184.216.34:443']);
      const s = proxy.stats();
      expect(s['blocked-address']).toBeGreaterThanOrEqual(6);
      expect(s['blocked-port']).toBe(1);
    } finally {
      await proxy.close();
    }
  });

  it('DNS-rebinding: каждый резолв проверяется, подключение — на проверенный IP', async () => {
    dialed.length = 0;
    let n = 0;
    const proxy = await startEgressFilterProxy({
      allowedPorts: [443],
      lookup: async () => (n++ === 0 ? ['93.184.216.34'] : ['10.0.0.5']),
      upstream: { protocol: 'http:', host: '127.0.0.1', port: upPort },
    });
    try {
      expect(await connectVia(proxy.port, 'rebind.test:443')).toBe(200);
      expect(await connectVia(proxy.port, 'rebind.test:443')).toBe(403);
      // Подключались по проверенному адресу, а не по имени.
      expect(dialed).toEqual(['93.184.216.34:443']);
    } finally {
      await proxy.close();
    }
  });

  it('страница не достаёт сам прокси/воркер по loopback', async () => {
    const proxy = await startEgressFilterProxy({
      allowedPorts: [80, 443, 8088],
    });
    try {
      expect(await connectVia(proxy.port, `127.0.0.1:${proxy.port}`)).toBe(403);
      expect(await connectVia(proxy.port, 'localhost:8088')).toBe(403);
    } finally {
      await proxy.close();
    }
    void netConnect;
  });
});
