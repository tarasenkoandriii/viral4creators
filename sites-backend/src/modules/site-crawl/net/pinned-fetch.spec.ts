/**
 * IP-pin: настоящий undici + TLS против локального стенда (LocalSites).
 * Полный список SSRF-векторов QA-ТЗ §5.4 — в acceptance/e1/ssrf-meta.spec.ts;
 * здесь — механика: pin, редиректы, лимит тела, таймаут, заголовки.
 */

import { BodyTooLargeError } from '../../../shared/external-url-guard';
import { LocalSites, PUBLIC_TEST_IP } from '../testing/local-sites.testing';
import {
  FetchTimeoutError,
  RedirectOffsiteError,
  SsrfBlockedError,
  assertCrawlableUrl,
  pinnedFetch,
} from './pinned-fetch';

const base = {
  maxBytes: 1024 * 1024,
  timeoutMs: 5000,
  maxRedirects: 5,
  sameOrigin: true,
};

describe('pinnedFetch (локальный https-стенд)', () => {
  const net = new LocalSites();

  beforeAll(async () => {
    await net.start();
  });
  afterAll(async () => {
    await net.stop();
  });
  beforeEach(() => {
    net.routes.clear();
    net.dns.clear();
    net.hits.length = 0;
    net.lookups.length = 0;
    net.dials.length = 0;
  });

  it('GET: Host и SNI — исходное имя, сокету отдан проверенный адрес', async () => {
    net.site('a.polygon.example', {
      '/x?y=1': (req) => net.html(`host=${req.headers.host}`),
    });
    const res = await pinnedFetch(
      'https://a.polygon.example/x?y=1',
      base,
      net.deps(),
    );
    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe('host=a.polygon.example');
    expect(res.ip).toBe(PUBLIC_TEST_IP);
    expect(net.dials).toEqual([
      { host: 'a.polygon.example', address: PUBLIC_TEST_IP },
    ]);
    expect(res.headers['content-type']).toContain('text/html');
  });

  it('резолв ровно один на хоп: второго (rebinding) ответа клиент не спрашивает', async () => {
    let n = 0;
    net.site('a.polygon.example', { '/': net.html('ok') });
    net.dns.set('a.polygon.example', () =>
      n++ === 0 ? [PUBLIC_TEST_IP] : ['127.0.0.1'],
    );
    const res = await pinnedFetch(
      'https://a.polygon.example/',
      base,
      net.deps(),
    );
    expect(res.status).toBe(200);
    expect(net.lookups).toEqual(['a.polygon.example']);
    expect(net.dials.map((d) => d.address)).toEqual([PUBLIC_TEST_IP]);
  });

  it('любой из адресов резолва служебный — отказ до подключения', async () => {
    net.site('a.polygon.example', { '/': net.html('ok') });
    net.dns.set('a.polygon.example', [PUBLIC_TEST_IP, '10.0.0.7']);
    await expect(
      pinnedFetch('https://a.polygon.example/', base, net.deps()),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(net.hits).toEqual([]);
    expect(net.dials).toEqual([]);
  });

  it('имя не резолвится — SsrfBlockedError', async () => {
    await expect(
      pinnedFetch('https://nope.polygon.example/', base, net.deps()),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it('редирект того же origin — идём, каждый хоп заново резолвится', async () => {
    net.site('a.polygon.example', {
      '/old': { status: 301, headers: { location: '/new' } },
      '/new': net.html('new'),
    });
    const res = await pinnedFetch(
      'https://a.polygon.example/old',
      base,
      net.deps(),
    );
    expect(res.url).toBe('https://a.polygon.example/new');
    expect(res.redirects).toEqual(['https://a.polygon.example/new']);
    expect(net.lookups).toHaveLength(2);
  });

  it('sameOrigin: редирект на другой хост — RedirectOffsiteError, туда не ходим', async () => {
    net.site('a.polygon.example', {
      '/': { status: 302, headers: { location: 'https://b.polygon.example/' } },
    });
    net.site('b.polygon.example', { '/': net.html('b') });
    await expect(
      pinnedFetch('https://a.polygon.example/', base, net.deps()),
    ).rejects.toBeInstanceOf(RedirectOffsiteError);
    expect(net.hits).toEqual(['a.polygon.example/']);
  });

  it('без sameOrigin: редирект на другой публичный хост — идём', async () => {
    net.site('a.polygon.example', {
      '/robots.txt': {
        status: 302,
        headers: { location: 'https://b.polygon.example/robots.txt' },
      },
    });
    net.site('b.polygon.example', {
      '/robots.txt': { status: 200, body: 'User-agent: *' },
    });
    const res = await pinnedFetch(
      'https://a.polygon.example/robots.txt',
      { ...base, sameOrigin: false },
      net.deps(),
    );
    expect(res.body.toString()).toBe('User-agent: *');
  });

  it('редирект на http:// — SsrfBlockedError (схема проверяется на каждом хопе)', async () => {
    net.site('a.polygon.example', {
      '/': { status: 302, headers: { location: 'http://a.polygon.example/' } },
    });
    await expect(
      pinnedFetch(
        'https://a.polygon.example/',
        { ...base, sameOrigin: false },
        net.deps(),
      ),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it('maxRedirects = 0 — 3xx отдаётся как есть (safe-http решает сам)', async () => {
    net.site('a.polygon.example', {
      '/': { status: 302, headers: { location: '/uk/' } },
    });
    const res = await pinnedFetch(
      'https://a.polygon.example/',
      { ...base, maxRedirects: 0 },
      net.deps(),
    );
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/uk/');
  });

  it('тело больше лимита — BodyTooLargeError; gzip считается по распакованному', async () => {
    net.site('a.polygon.example', {
      '/big': net.html('x'.repeat(5000)),
      '/bomb': { ...net.html('y'.repeat(200_000)), gzip: true },
    });
    await expect(
      pinnedFetch(
        'https://a.polygon.example/big',
        { ...base, maxBytes: 1000 },
        net.deps(),
      ),
    ).rejects.toBeInstanceOf(BodyTooLargeError);
    await expect(
      pinnedFetch(
        'https://a.polygon.example/bomb',
        { ...base, maxBytes: 10_000 },
        net.deps(),
      ),
    ).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  it('truncateAtMaxBytes — обрезка вместо ошибки; gzip распаковывается', async () => {
    net.site('a.polygon.example', {
      '/z': { ...net.html('абв'.repeat(1000)), gzip: true },
    });
    const res = await pinnedFetch(
      'https://a.polygon.example/z',
      { ...base, maxBytes: 10, truncateAtMaxBytes: true },
      net.deps(),
    );
    expect(res.body.length).toBe(10);
    const full = await pinnedFetch(
      'https://a.polygon.example/z',
      base,
      net.deps(),
    );
    expect(full.body.toString()).toBe('абв'.repeat(1000));
  });

  it('таймаут на весь запрос — FetchTimeoutError', async () => {
    net.site('a.polygon.example', {
      '/slow': { ...net.html('late'), delayMs: 400 },
    });
    await expect(
      pinnedFetch(
        'https://a.polygon.example/slow',
        { ...base, timeoutMs: 100 },
        net.deps(),
      ),
    ).rejects.toBeInstanceOf(FetchTimeoutError);
  });
});

describe('assertCrawlableUrl', () => {
  it.each([
    'http://shop.example.com/',
    'https://shop.example.com:8443/',
    'https://user:pass@shop.example.com/',
    'https://2130706433/',
    'https://0177.0.0.1/',
    'https://0x7f.1/',
    'https://[::1]/',
    'https://[::ffff:7f00:1]/',
    'https://localhost/',
    'ftp://shop.example.com/',
    'не ссылка',
  ])('%s — отказ', (url) => {
    expect(() => assertCrawlableUrl(url)).toThrow(SsrfBlockedError);
  });

  it('https на 443 с явным портом — допустимо', () => {
    expect(assertCrawlableUrl('https://shop.example.com:443/a').href).toBe(
      'https://shop.example.com/a',
    );
  });
});
