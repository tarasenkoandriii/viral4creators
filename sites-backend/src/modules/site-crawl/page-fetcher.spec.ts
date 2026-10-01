/**
 * PublicPageFetcher — одна страница «как есть»: причины пропуска, условный
 * запрос, кодировки, вежливость к хосту. Сеть — локальный https-стенд.
 */

import { CRAWLER_USER_AGENT } from '../../brand';
import { PublicPageFetcher, decodeHtml, headerNoindex } from './page-fetcher';
import { RobotsService } from './robots';
import { memoryCacheDb } from './testing/crawl-stack.testing';
import { LocalSites } from './testing/local-sites.testing';

const H = 'fetch.polygon.example';
const U = `https://${H}`;

describe('PublicPageFetcher (стенд)', () => {
  const net = new LocalSites();
  let fetcher: PublicPageFetcher;

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
    fetcher = new PublicPageFetcher(new RobotsService(net.deps()), net.deps());
    net.site(H, { '/robots.txt': { status: 404 } });
  });

  const opts = () => ({
    purpose: 'assist-crawl' as const,
    db: memoryCacheDb(),
  });

  it('ok: свой UA, без cookie; извлечение, etag/last-modified', async () => {
    let seen: Record<string, unknown> = {};
    net.site(H, {
      '/p': (req) => {
        seen = req.headers;
        return net.html('<main><h1>Товар</h1><p>Опис.</p></main>', {
          headers: {
            etag: '"v1"',
            'last-modified': 'Wed, 01 Oct 2026 10:00:00 GMT',
            'set-cookie': 's=1',
          },
        });
      },
    });
    const r = await fetcher.fetchPage(`${U}/p?utm_source=x`, opts());
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('недостижимо');
    expect(r.page.url).toBe(`${U}/p`);
    expect(r.page.text).toBe('Товар\nОпис.');
    expect(r.etag).toBe('"v1"');
    expect(r.lastModified).toBe('Wed, 01 Oct 2026 10:00:00 GMT');
    expect(seen['user-agent']).toBe(CRAWLER_USER_AGENT);
    expect(seen.cookie).toBeUndefined();
  });

  it('условный запрос: If-None-Match/If-Modified-Since → 304 = notModified', async () => {
    let seen: Record<string, unknown> = {};
    net.site(H, {
      '/p': (req) => {
        seen = req.headers;
        return { status: 304 };
      },
    });
    const r = await fetcher.fetchPage(`${U}/p`, {
      ...opts(),
      conditional: {
        etag: '"v1"',
        lastModified: 'Wed, 01 Oct 2026 10:00:00 GMT',
      },
    });
    expect(r).toEqual({ ok: false, notModified: true, httpStatus: 304 });
    expect(seen['if-none-match']).toBe('"v1"');
    expect(seen['if-modified-since']).toBe('Wed, 01 Oct 2026 10:00:00 GMT');
  });

  it.each([
    [
      '/pdf',
      {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
        body: '%PDF',
      },
      'not_html',
      200,
    ],
    ['/404', { status: 404 }, 'http_4xx', 404],
    ['/410', { status: 410 }, 'http_4xx', 410],
    ['/403', { status: 403 }, 'http_4xx', 403],
    ['/500', { status: 500 }, 'http_5xx', 500],
    ['/429', { status: 429 }, 'http_5xx', 429],
    [
      '/xrt',
      {
        status: 200,
        headers: { 'content-type': 'text/html', 'x-robots-tag': 'noindex' },
        body: '<p>x</p>',
      },
      'noindex',
      200,
    ],
    [
      '/empty',
      {
        status: 200,
        headers: { 'content-type': 'text/html' },
        body: '<html><body></body></html>',
      },
      'empty',
      200,
    ],
  ])('%s → %s', async (path, route, reason, status) => {
    net.site(H, { [path]: route });
    expect(await fetcher.fetchPage(`${U}${path}`, opts())).toEqual({
      ok: false,
      reason,
      httpStatus: status,
    });
  });

  it('opt-out домена (родительское имя) — без запроса', async () => {
    const r = await fetcher.fetchPage(`${U}/`, {
      purpose: 'assist-sandbox',
      db: memoryCacheDb(['polygon.example']),
    });
    expect(r).toEqual({ ok: false, reason: 'opted_out' });
    expect(net.hits).toEqual([]);
  });

  it('robots запрещает — без запроса страницы', async () => {
    net.site(H, {
      '/robots.txt': { status: 200, body: 'User-agent: *\nDisallow: /x' },
    });
    expect(await fetcher.fetchPage(`${U}/x/1`, opts())).toEqual({
      ok: false,
      reason: 'robots',
    });
    expect(net.hits).toEqual([`${H}/robots.txt`]);
  });

  it('тело больше лимита — too_large; редирект на другой хост — redirect_offsite; таймаут/обрыв — timeout', async () => {
    net.site(H, {
      '/big': net.html(`<p>${'x'.repeat(3 * 1024 * 1024 + 10)}</p>`),
      '/away': {
        status: 302,
        headers: { location: 'https://elsewhere.polygon.example/' },
      },
    });
    expect(await fetcher.fetchPage(`${U}/big`, opts())).toEqual({
      ok: false,
      reason: 'too_large',
    });
    expect(await fetcher.fetchPage(`${U}/away`, opts())).toEqual({
      ok: false,
      reason: 'redirect_offsite',
    });
    net.dns.set('dead.polygon.example', ['93.184.216.34']);
    // Порт стенда закрыт — обрыв соединения; для владельца это «не ответил».
    const allowAll = {
      rulesFor: async () => ({
        isAllowed: () => true,
        crawlDelayMs: null,
        sitemaps: [],
      }),
    } as unknown as RobotsService;
    const dead = new PublicPageFetcher(allowAll, {
      ...net.deps(),
      portOverride: 1,
    });
    expect(
      await dead.fetchPage('https://dead.polygon.example/', opts()),
    ).toEqual({
      ok: false,
      reason: 'timeout',
    });
  });

  it('кодировка windows-1251 из Content-Type и из <meta charset>', async () => {
    const cp1251 = Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]); // «Привет»
    net.site(H, {
      '/ct': {
        status: 200,
        headers: { 'content-type': 'text/html; charset=windows-1251' },
        body: Buffer.concat([Buffer.from('<p>'), cp1251, Buffer.from('</p>')]),
      },
      '/meta': {
        status: 200,
        headers: { 'content-type': 'text/html' },
        body: Buffer.concat([
          Buffer.from('<meta charset="windows-1251"><p>'),
          cp1251,
          Buffer.from('</p>'),
        ]),
      },
    });
    for (const p of ['/ct', '/meta']) {
      const r = await fetcher.fetchPage(`${U}${p}`, opts());
      expect(r.ok && r.page.text).toBe('Привет');
    }
    expect(decodeHtml(Buffer.from('ok'), 'text/html; charset=no-such')).toBe(
      'ok',
    );
  });

  it('вежливость: пауза между запросами к одному хосту', async () => {
    net.site(H, { '/a': net.html('<p>a</p>'), '/b': net.html('<p>b</p>') });
    const t0 = Date.now();
    await fetcher.fetchPage(`${U}/a`, { ...opts(), minDelayMsPerHost: 300 });
    await fetcher.fetchPage(`${U}/b`, { ...opts(), minDelayMsPerHost: 300 });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(290);
  });

  it('SPA-оболочка — spa, а не empty', async () => {
    net.site(H, {
      '/app': net.html('<div id="app"></div><script src="/main.js"></script>'),
    });
    expect(await fetcher.fetchPage(`${U}/app`, opts())).toEqual({
      ok: false,
      reason: 'spa',
      httpStatus: 200,
    });
  });
});

describe('headerNoindex', () => {
  it.each([
    ['noindex', true],
    ['none', true],
    ['noindex, nofollow', true],
    ['googlebot: noindex', false],
    ['v4c-assist: noindex', true],
    ['googlebot: noindex, v4c-assist: none', true],
    ['nofollow', false],
    [undefined, false],
  ])('%s → %s', (v, want) => {
    expect(headerNoindex(v)).toBe(want);
  });
});
