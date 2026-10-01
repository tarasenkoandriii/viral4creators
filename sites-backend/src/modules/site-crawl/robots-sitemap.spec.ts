/**
 * robots.txt и sitemap поверх локального https-стенда (сеть настоящая,
 * кэш robots — в памяти; кэш в Postgres проверяет crawl-polygon).
 */

import { gzipSync } from 'zlib';
import {
  RobotsService,
  ROBOTS_ERROR_TTL_MS,
  rulesFromSnapshot,
} from './robots';
import { SitemapService, parseSitemap } from './sitemap';
import { memoryCacheDb } from './testing/crawl-stack.testing';
import { LocalSites } from './testing/local-sites.testing';

const H = 'robots.polygon.example';
const O = `https://${H}`;

describe('rulesFromSnapshot', () => {
  const txt = [
    'User-agent: *',
    'Disallow: /',
    '',
    'User-agent: V4C-Assist',
    'Disallow: /admin',
    'Allow: /admin/public',
    'Crawl-delay: 2',
    'Sitemap: https://robots.polygon.example/s.xml',
    'Sitemap: http://robots.polygon.example/insecure.xml',
  ].join('\n');

  it('группа нашего UA важнее `*`; Allow/Disallow; Crawl-delay; только https sitemap', () => {
    const r = rulesFromSnapshot({ origin: O, httpStatus: 200, body: txt });
    expect(r.isAllowed(`${O}/`)).toBe(true);
    expect(r.isAllowed(`${O}/admin/x`)).toBe(false);
    expect(r.isAllowed(`${O}/admin/public/y`)).toBe(true);
    expect(r.crawlDelayMs).toBe(2000);
    expect(r.sitemaps).toEqual([`${O}/s.xml`]);
  });

  it('без группы нашего UA действует `*`', () => {
    const r = rulesFromSnapshot({
      origin: O,
      httpStatus: 200,
      body: 'User-agent: *\nDisallow: /cart',
    });
    expect(r.isAllowed(`${O}/cart/1`)).toBe(false);
    expect(r.isAllowed(`${O}/catalog`)).toBe(true);
  });

  it('URL другого origin не разрешается чужим robots', () => {
    const r = rulesFromSnapshot({ origin: O, httpStatus: 200, body: '' });
    expect(r.isAllowed('https://other.polygon.example/')).toBe(false);
  });

  it('4xx — всё разрешено; 5xx/429/сеть — всё запрещено', () => {
    expect(
      rulesFromSnapshot({ origin: O, httpStatus: 404, body: null }).isAllowed(
        `${O}/a`,
      ),
    ).toBe(true);
    expect(
      rulesFromSnapshot({ origin: O, httpStatus: 503, body: null }).isAllowed(
        `${O}/a`,
      ),
    ).toBe(false);
    expect(
      rulesFromSnapshot({ origin: O, httpStatus: 429, body: null }).isAllowed(
        `${O}/a`,
      ),
    ).toBe(false);
    expect(
      rulesFromSnapshot({ origin: O, httpStatus: null, body: null }).isAllowed(
        `${O}/a`,
      ),
    ).toBe(false);
  });
});

describe('RobotsService / SitemapService (стенд)', () => {
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
  });

  it('robots: кэш по origin — второй вызов без сети; сбой кэшируется коротко', async () => {
    net.site(H, {
      '/robots.txt': { status: 200, body: 'User-agent: *\nDisallow: /x' },
    });
    const db = memoryCacheDb();
    const svc = new RobotsService(net.deps());
    const r1 = await svc.rulesFor(`${O}/any/path`, db);
    const r2 = await svc.rulesFor(O, db);
    expect(r1.isAllowed(`${O}/x/1`)).toBe(false);
    expect(r2.isAllowed(`${O}/y`)).toBe(true);
    expect(net.hits).toEqual([`${H}/robots.txt`]);

    const upserts: Array<{ expiresAt: Date; fetchedAt: Date }> = [];
    const db2 = memoryCacheDb();
    const orig = db2.siteCrawlRobots.upsert;
    (db2.siteCrawlRobots as unknown as { upsert: unknown }).upsert = async (a: {
      create: { expiresAt: Date; fetchedAt: Date };
    }) => {
      upserts.push(a.create);
      return (orig as unknown as (x: unknown) => Promise<unknown>)(a);
    };
    net.site(H, { '/robots.txt': { status: 503 } });
    const r3 = await new RobotsService(net.deps()).rulesFor(O, db2);
    expect(r3.isAllowed(`${O}/`)).toBe(false);
    expect(
      upserts[0].expiresAt.getTime() - upserts[0].fetchedAt.getTime(),
    ).toBe(ROBOTS_ERROR_TTL_MS);
  });

  it('robots больше лимита — читается начало, а не отказ', async () => {
    net.site(H, {
      '/robots.txt': {
        status: 200,
        body: 'User-agent: *\nDisallow: /secret\n#' + 'x'.repeat(600 * 1024),
      },
    });
    const r = await new RobotsService(net.deps()).rulesFor(O, memoryCacheDb());
    expect(r.isAllowed(`${O}/secret`)).toBe(false);
  });

  it('sitemap: индекс → дочерние (xml и gzip), только тот же хост и разрешённые robots, порядок по lastmod', async () => {
    net.site(H, {
      '/sitemap.xml': {
        status: 200,
        headers: { 'content-type': 'application/xml' },
        body: `<?xml version="1.0"?><sm:sitemapindex xmlns:sm="http://www.sitemaps.org/schemas/sitemap/0.9">
          <sm:sitemap><sm:loc>${O}/a.xml</sm:loc></sm:sitemap>
          <sm:sitemap><sm:loc>${O}/b.xml.gz</sm:loc></sm:sitemap>
          <sm:sitemap><sm:loc>${O}/a.xml</sm:loc></sm:sitemap>
        </sm:sitemapindex>`,
      },
      '/a.xml': {
        status: 200,
        body: `<urlset><url><loc>${O}/old</loc><lastmod>2020-01-01</lastmod></url>
          <url><loc>${O}/new?utm_source=x</loc><lastmod>2026-09-30T10:00:00+03:00</lastmod></url>
          <url><loc>${O}/blocked/1</loc></url>
          <url><loc>https://elsewhere.polygon.example/x</loc></url>
          <url><loc>http://${H}/insecure</loc></url></urlset>`,
      },
      '/b.xml.gz': {
        status: 200,
        headers: { 'content-type': 'application/x-gzip' },
        body: gzipSync(
          `<urlset><url><loc>${O}/mid</loc><lastmod>2024-05-05</lastmod></url></urlset>`,
        ),
      },
    });
    const robots = rulesFromSnapshot({
      origin: O,
      httpStatus: 200,
      body: 'User-agent: *\nDisallow: /blocked',
    });
    const entries = await new SitemapService(net.deps()).discover(
      O,
      robots,
      10,
    );
    expect(entries.map((e) => e.url)).toEqual([
      `${O}/new`,
      `${O}/mid`,
      `${O}/old`,
    ]);
    expect(net.hits.filter((h) => h.endsWith('a.xml'))).toHaveLength(1);
  });

  it('sitemap: лимит URL и sitemap из robots', async () => {
    const urls = Array.from(
      { length: 30 },
      (_, i) => `<url><loc>${O}/p/${i}</loc></url>`,
    ).join('');
    net.site(H, {
      '/custom-map.xml': { status: 200, body: `<urlset>${urls}</urlset>` },
    });
    const robots = rulesFromSnapshot({
      origin: O,
      httpStatus: 200,
      body: `Sitemap: ${O}/custom-map.xml`,
    });
    const entries = await new SitemapService(net.deps()).discover(O, robots, 5);
    expect(entries).toHaveLength(5);
  });

  it('parseSitemap: текстовый формат и битый XML не роняют', () => {
    expect(parseSitemap(`${O}/a\n\n${O}/b\n`).urls.map((u) => u.loc)).toEqual([
      `${O}/a`,
      `${O}/b`,
    ]);
    expect(
      parseSitemap('<urlset><url><loc>x</loc><lastmod>не дата</lastmod>').urls,
    ).toEqual([{ loc: 'x', lastmod: null }]);
  });
});
