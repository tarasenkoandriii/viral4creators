/**
 * Фильтр исходящего трафика браузера реле (Ш0.2, риск К-1 аудита
 * docs-tz/AUDIT-Merge-Assistant-Tutorial-QA-2026-10-02.md).
 *
 * Сам прокси подробно проверяется в backend
 * (`backend/src/common/egress-filter-proxy.spec.ts`, копия совпадает —
 * `scripts/sync-relay-shared.mjs --check`). Здесь — то, что принадлежит
 * реле: конфигурация (фильтр нельзя выключить в production, кривые
 * значения роняют старт) и то, что браузер действительно получает флаги
 * фильтра, а фильтр действительно режет служебные адреса.
 */

import { connect } from 'node:net';
import {
  ConfigError,
  egressStartupWarnings,
  loadConfig,
  parseEgressFilter,
  upstreamFromBrowserProxy,
} from '../src/config';
import { BrowserNetwork, startBrowserNetwork } from '../src/browser-network';

const BASE_ENV = {
  PUPPETEER_EXECUTABLE_PATH: '/usr/bin/chromium',
  LIVE_LOGIN_RELAY_SECRET: 'x'.repeat(32),
};

describe('parseEgressFilter', () => {
  it('по умолчанию фильтр ВКЛЮЧЁН, порты 80/443/8080/8443', () => {
    expect(parseEgressFilter({})).toEqual({
      enabled: true,
      denyCidrs: [],
      allowedPorts: [80, 443, 8080, 8443],
    });
  });

  it('off в production — отказ стартовать', () => {
    expect(() =>
      parseEgressFilter({
        LIVE_LOGIN_EGRESS_FILTER: 'off',
        NODE_ENV: 'production',
      }),
    ).toThrow(ConfigError);
  });

  it('off вне production — можно (локальная отладка)', () => {
    expect(parseEgressFilter({ LIVE_LOGIN_EGRESS_FILTER: 'off' }).enabled).toBe(
      false,
    );
  });

  it('неизвестный режим — отказ, а не «выключено»', () => {
    expect(() => parseEgressFilter({ LIVE_LOGIN_EGRESS_FILTER: 'no' })).toThrow(
      ConfigError,
    );
  });

  it('адреса хоста: IPv4 и IPv6-подсеть принимаются, кривая запись — отказ', () => {
    expect(
      parseEgressFilter({
        LIVE_LOGIN_EGRESS_DENY: ' 203.0.113.10 , 2a01:4f8:c0c:1::/64 ',
      }).denyCidrs,
    ).toEqual(['203.0.113.10', '2a01:4f8:c0c:1::/64']);
    expect(() =>
      parseEgressFilter({ LIVE_LOGIN_EGRESS_DENY: '203.0.113.10/40' }),
    ).toThrow(ConfigError);
  });

  it('порты: кривое значение — отказ', () => {
    expect(
      parseEgressFilter({ LIVE_LOGIN_EGRESS_ALLOWED_PORTS: '443' })
        .allowedPorts,
    ).toEqual([443]);
    expect(() =>
      parseEgressFilter({ LIVE_LOGIN_EGRESS_ALLOWED_PORTS: '443,ssh' }),
    ).toThrow(ConfigError);
  });

  it('loadConfig: фильтр включён без единой новой переменной', () => {
    expect(loadConfig({ ...BASE_ENV }).egressFilter.enabled).toBe(true);
  });

  it('loadConfig: socks4-выход при фильтре — отказ стартовать (мимо фильтра не идём)', () => {
    expect(() =>
      loadConfig({
        ...BASE_ENV,
        LIVE_LOGIN_BROWSER_PROXY_URL: 'socks4://h:1080',
      }),
    ).toThrow(ConfigError);
  });
});

describe('upstreamFromBrowserProxy', () => {
  it('http-выход с логином → вышестоящий фильтра', () => {
    expect(
      upstreamFromBrowserProxy({
        server: 'http://p.example.com:3128',
        username: 'u',
        password: 'p',
      }),
    ).toEqual({
      protocol: 'http:',
      host: 'p.example.com',
      port: 3128,
      username: 'u',
      password: 'p',
    });
    expect(upstreamFromBrowserProxy(null)).toBeNull();
  });
});

/** Сырой CONNECT к фильтру — ответ до закрытия. */
function rawConnect(proxyUrl: string, authority: string): Promise<string> {
  const port = Number(new URL(proxyUrl).port);
  return new Promise((resolve) => {
    const s = connect(port, '127.0.0.1');
    let out = '';
    const timer = setTimeout(() => {
      s.destroy();
      resolve(out);
    }, 3000);
    s.on('data', (d) => (out += d.toString('latin1')));
    s.on('close', () => {
      clearTimeout(timer);
      resolve(out);
    });
    s.on('error', () => undefined);
    s.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
  });
}

describe('startBrowserNetwork', () => {
  let network: BrowserNetwork | null = null;
  afterEach(async () => {
    await network?.close();
    network = null;
  });

  it('фильтр включён: браузер получает ТОЛЬКО прокси-фильтр, без page.authenticate', async () => {
    network = await startBrowserNetwork({
      browserProxy: {
        server: 'http://p.example.com:3128',
        username: 'u',
        password: 'secret',
      },
      egressFilter: { enabled: true, denyCidrs: [], allowedPorts: [443] },
    });
    expect(network.filterUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(network.launchArgs).toEqual([
      `--proxy-server=${network.filterUrl}`,
      '--proxy-bypass-list=<-loopback>',
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--disable-quic',
    ]);
    // Пароль выхода не уходит ни в аргументы процесса, ни странице.
    expect(network.launchArgs.join(' ')).not.toContain('secret');
    expect(network.proxyAuth).toBeUndefined();
  });

  it.each([
    ['метаданные Hetzner', '169.254.169.254:80'],
    ['панель Dokploy в сети Docker', '10.0.1.5:3000'],
    ['сам реле', '127.0.0.1:8088'],
    ['адрес хоста из LIVE_LOGIN_EGRESS_DENY', '203.0.113.10:443'],
  ])('фильтр режет: %s', async (_name, authority) => {
    const warned: unknown[] = [];
    network = await startBrowserNetwork(
      {
        browserProxy: null,
        egressFilter: {
          enabled: true,
          denyCidrs: ['203.0.113.10'],
          allowedPorts: [80, 443, 3000, 8088],
        },
      },
      { warn: (_msg, extra) => warned.push(extra) },
    );
    const out = await rawConnect(network.filterUrl as string, authority);
    expect(out).toMatch(/^HTTP\/1\.1 403/);
    expect(network.stats()?.['blocked-address']).toBe(1);
    // В логе — вид отказа, без адреса.
    expect(warned).toEqual([{ verdict: 'blocked-address' }]);
  });

  it('фильтр выключен (отладка): прежнее поведение — прямой прокси и authenticate', async () => {
    network = await startBrowserNetwork({
      browserProxy: { server: 'http://h:80', username: 'u', password: 'p' },
      egressFilter: { enabled: false, denyCidrs: [], allowedPorts: [] },
    });
    expect(network.launchArgs).toEqual(['--proxy-server=http://h:80']);
    expect(network.proxyAuth).toEqual({ username: 'u', password: 'p' });
    expect(network.filterUrl).toBeNull();
  });
});

describe('egressStartupWarnings (аудит Ш0)', () => {
  const filter = (denyCidrs: string[]) => ({
    egressFilter: { enabled: true, denyCidrs, allowedPorts: [443] },
  });

  it('production без адресов сервера — предупреждение', () => {
    const w = egressStartupWarnings(filter([]), { NODE_ENV: 'production' });
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('LIVE_LOGIN_EGRESS_DENY');
  });

  it('адреса заданы или не production — тишина', () => {
    expect(
      egressStartupWarnings(filter(['203.0.113.7']), {
        NODE_ENV: 'production',
      }),
    ).toEqual([]);
    expect(egressStartupWarnings(filter([]), {})).toEqual([]);
  });
});
