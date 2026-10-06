import { ConfigError, loadConfig } from '../../src/config';
import { generateWorkerSealKeys } from '../../src/shared/worker-seal';

const base = {
  SITES_BACKEND_URL: 'https://sites.example',
  SITES_WORKER_HMAC_SECRET: 's'.repeat(40),
  BROWSER_WORKER_SANDBOX: 'off',
} as NodeJS.ProcessEnv;

describe('config воркера', () => {
  it('умолчания: без ключа конверта обход «Админки» не берётся', () => {
    const c = loadConfig(base);
    expect(c.kinds).not.toContain('admin-crawl');
    expect(c.kinds).toContain('ui-snapshot');
    expect(c.egressPorts).toEqual([80, 443]);
  });

  it('с ключом конверта — берётся, открытый ключ выводится из закрытого', () => {
    const k = generateWorkerSealKeys();
    const c = loadConfig({
      ...base,
      BROWSER_WORKER_SEAL_PRIVATE_KEY: k.privateKey,
    });
    expect(c.kinds).toContain('admin-crawl');
    expect(c.sealPublicKey).toBe(k.publicKey);
  });

  it.each([
    [{ SITES_BACKEND_URL: '' }, /SITES_BACKEND_URL/],
    [{ SITES_WORKER_HMAC_SECRET: 'short' }, /HMAC/],
    [{ BROWSER_WORKER_KINDS: 'ui-snapshot,shell' }, /KINDS/],
    [{ BROWSER_WORKER_EGRESS_DENY: 'not-an-ip' }, /EGRESS_DENY/],
    [{ BROWSER_WORKER_TEST_DNS: 'a=1.2.3.4' }, /NODE_ENV=test/],
    [{ BROWSER_WORKER_TEST_IGNORE_TLS: '1' }, /NODE_ENV=test/],
    [{ BROWSER_WORKER_SEAL_PRIVATE_KEY: 'nope' }, /SEAL_PRIVATE_KEY/],
  ])('отказ стартовать: %p', (patch, re) => {
    expect(() => loadConfig({ ...base, ...patch })).toThrow(re);
  });

  it('production: только https, песочница обязательна, адреса сервера в фильтре обязательны', () => {
    const prod = {
      ...base,
      NODE_ENV: 'production',
      BROWSER_WORKER_EGRESS_DENY: '203.0.113.7/32',
    };
    expect(() =>
      loadConfig({ ...prod, SITES_BACKEND_URL: 'http://sites.example' }),
    ).toThrow(/https/);
    expect(() => loadConfig(prod)).toThrow(/SANDBOX=off/);
    expect(() =>
      loadConfig({
        ...prod,
        BROWSER_WORKER_SANDBOX: 'off',
        BROWSER_WORKER_EGRESS_DENY: '',
      }),
    ).toThrow(ConfigError);
  });

  it('песочница под root — отказ (нужен USER в образе)', () => {
    const spy = jest.spyOn(process, 'getuid').mockReturnValue(0);
    try {
      expect(() =>
        loadConfig({ ...base, BROWSER_WORKER_SANDBOX: 'on' }),
      ).toThrow(/не-root/);
    } finally {
      spy.mockRestore();
    }
  });

  it('тестовые подмены — только NODE_ENV=test', () => {
    const c = loadConfig({
      ...base,
      NODE_ENV: 'test',
      BROWSER_WORKER_TEST_DNS: 'Shop.test=93.184.216.34',
      BROWSER_WORKER_TEST_IGNORE_TLS: '1',
    });
    expect(c.testDns?.get('shop.test')).toEqual(['93.184.216.34']);
    expect(c.testIgnoreTls).toBe(true);
  });
});
