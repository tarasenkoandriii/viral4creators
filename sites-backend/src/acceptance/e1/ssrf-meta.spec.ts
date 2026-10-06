/**
 * Приёмка Э1 A5/C5 (K1): мета-тест SSRF — ОБЯЗАТЕЛЬНЫЙ список QA-ТЗ §5.4
 * (контракт Э1 §5). Песочница сайта лендинга не открывается, пока этот
 * тест не зелёный (лендинг-ТЗ §6.4).
 *
 * Настоящий стек сети: pinnedFetch (undici + TLS + IP-pin), RobotsService,
 * SitemapService, PublicPageFetcher (вход песочницы, purpose
 * `assist-sandbox`) и запрос проверки владения (safe-http). Подменяются
 * только резолвер и адрес подключения локального стенда. База не нужна:
 * кэш robots/opt-out — в памяти, тест идёт всегда.
 *
 * Для каждого вектора проверяется не только «отказ», но и «ни одного
 * подключения к запрещённому адресу» (`dials`) и «ни одного запроса до
 * стенда» (`hits`) — отказ ПОСЛЕ подключения был бы уже утечкой.
 */

import {
  checkMeta,
  OwnershipChecker,
} from '../../modules/site-core/ownership/ownership-checker';
import {
  DEFAULT_SAFE_HTTP_DEPS,
  fetchSameOrigin,
  pinnedFetchLike,
} from '../../modules/site-core/ownership/safe-http';
import { DohClient } from '../../modules/site-core/ownership/doh.client';
import {
  SsrfBlockedError,
  assertCrawlableUrl,
  pinnedFetch,
} from '../../modules/site-crawl/net/pinned-fetch';
import { PublicPageFetcher } from '../../modules/site-crawl/page-fetcher';
import { RobotsService } from '../../modules/site-crawl/robots';
import { SitemapService } from '../../modules/site-crawl/sitemap';
import { memoryCacheDb } from '../../modules/site-crawl/testing/crawl-stack.testing';
import {
  LocalSites,
  PUBLIC_TEST_IP,
} from '../../modules/site-crawl/testing/local-sites.testing';
import { UnsafeExternalUrlError } from '../../shared/external-url-guard';

// Поднятие стенда и HTTP-серии под нагрузкой CI дольше 5 с по умолчанию.
jest.setTimeout(30_000);

const SITE = 'shop.ssrf.example';
const OPTS = {
  maxBytes: 1024 * 1024,
  timeoutMs: 5000,
  maxRedirects: 5,
  sameOrigin: false,
};

describe('мета-тест SSRF (QA-ТЗ §5.4, лендинг-ТЗ §6.4)', () => {
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

  /** Ни одного подключения, кроме проверенного публичного адреса. */
  function expectNoForbiddenDial(): void {
    expect(net.dials.every((d) => d.address === PUBLIC_TEST_IP)).toBe(true);
  }

  describe('редирект на внутренний адрес — отказ на хопе, второго запроса нет', () => {
    it.each([
      ['http://169.254.169.254/latest/meta-data/', 'http:// на метаданные'],
      ['https://169.254.169.254/latest/meta-data/', 'IP-литерал метаданных'],
      ['https://2130706433/', 'десятичный loopback'],
      ['https://[::1]/', 'IPv6 loopback'],
      ['https://meta.ssrf.example/', 'имя → 169.254.169.254'],
      ['https://internal.ssrf.example/', 'имя → ::ffff:7f00:1'],
      ['http://shop.ssrf.example/plain', 'тот же публичный хост, но http://'],
      ['https://shop.ssrf.example:8443/', 'тот же хост, нестандартный порт'],
      ['https://user:pass@shop.ssrf.example/', 'user:pass@ в Location'],
    ])('302 → %s (%s)', async (location) => {
      net.site(SITE, { '/': { status: 302, headers: { location } } });
      net.dns.set('meta.ssrf.example', ['169.254.169.254']);
      net.dns.set('internal.ssrf.example', ['::ffff:7f00:1']);
      await expect(
        pinnedFetch(`https://${SITE}/`, OPTS, net.deps()),
      ).rejects.toBeInstanceOf(SsrfBlockedError);
      expect(net.hits).toEqual([`${SITE}/`]);
      expectNoForbiddenDial();
    });

    it('robots.txt с редиректом на метаданные — robots «всё запрещено», обход не идёт', async () => {
      net.site(SITE, {
        '/robots.txt': {
          status: 301,
          headers: { location: 'https://meta.ssrf.example/robots.txt' },
        },
        '/': net.html('<main><p>страница</p></main>'),
      });
      net.dns.set('meta.ssrf.example', ['169.254.169.254']);
      const fetcher = new PublicPageFetcher(
        new RobotsService(net.deps()),
        net.deps(),
      );
      const r = await fetcher.fetchPage(`https://${SITE}/`, {
        purpose: 'assist-sandbox',
        db: memoryCacheDb(),
      });
      expect(r).toEqual({ ok: false, reason: 'robots' });
      expect(net.hits).toEqual([`${SITE}/robots.txt`]);
      expectNoForbiddenDial();
    });

    it('sitemap-индекс со ссылкой на внутренний хост — не запрашивается', async () => {
      net.site(SITE, {
        '/sitemap.xml': {
          status: 200,
          headers: { 'content-type': 'application/xml' },
          body: `<sitemapindex><sitemap><loc>https://meta.ssrf.example/s.xml</loc></sitemap><sitemap><loc>https://${SITE}/s2.xml</loc></sitemap></sitemapindex>`,
        },
        '/s2.xml': {
          status: 302,
          headers: { location: 'https://meta.ssrf.example/s3.xml' },
        },
      });
      net.dns.set('meta.ssrf.example', ['169.254.169.254']);
      const entries = await new SitemapService(net.deps()).discover(
        `https://${SITE}`,
        { isAllowed: () => true, crawlDelayMs: null, sitemaps: [] },
        10,
      );
      expect(entries).toEqual([]);
      expect(net.lookups).not.toContain('meta.ssrf.example');
      expectNoForbiddenDial();
    });
  });

  describe('DNS-rebinding: соединение идёт на ПЕРВЫЙ (проверенный) ответ', () => {
    it('резолвер: 1-й ответ публичный, 2-й — 127.0.0.1 → подключение к 1-му, второго резолва нет', async () => {
      let n = 0;
      net.site(SITE, { '/': net.html('<main><p>ok</p></main>') });
      net.dns.set(SITE, () => (n++ === 0 ? [PUBLIC_TEST_IP] : ['127.0.0.1']));
      const res = await pinnedFetch(`https://${SITE}/`, OPTS, net.deps());
      expect(res.status).toBe(200);
      expect(res.ip).toBe(PUBLIC_TEST_IP);
      expect(net.lookups).toEqual([SITE]);
      expect(net.dials).toEqual([{ host: SITE, address: PUBLIC_TEST_IP }]);
    });

    it('редирект на тот же хост: хоп резолвится заново — 127.0.0.1 → отказ, подключения нет', async () => {
      let n = 0;
      net.site(SITE, {
        '/': { status: 302, headers: { location: '/next' } },
        '/next': net.html('секрет'),
      });
      net.dns.set(SITE, () => (n++ === 0 ? [PUBLIC_TEST_IP] : ['127.0.0.1']));
      await expect(
        pinnedFetch(
          `https://${SITE}/`,
          { ...OPTS, sameOrigin: true },
          net.deps(),
        ),
      ).rejects.toBeInstanceOf(SsrfBlockedError);
      expect(net.hits).toEqual([`${SITE}/`]);
      expect(net.dials).toEqual([{ host: SITE, address: PUBLIC_TEST_IP }]);
    });

    it('песочница (PublicPageFetcher): robots — публичный ответ, страница — 127.0.0.1 → ssrf', async () => {
      let n = 0;
      net.site(SITE, {
        '/robots.txt': { status: 404 },
        '/': net.html('<main><p>секрет</p></main>'),
      });
      net.dns.set(SITE, () => (n++ === 0 ? [PUBLIC_TEST_IP] : ['127.0.0.1']));
      const fetcher = new PublicPageFetcher(
        new RobotsService(net.deps()),
        net.deps(),
      );
      const r = await fetcher.fetchPage(`https://${SITE}/`, {
        purpose: 'assist-sandbox',
        db: memoryCacheDb(),
      });
      expect(r).toEqual({ ok: false, reason: 'ssrf' });
      expect(net.hits).toEqual([`${SITE}/robots.txt`]);
      expectNoForbiddenDial();
    });
  });

  describe('резолв в служебный диапазон (в т.ч. IPv4 в обёртке IPv6) — отказ до подключения', () => {
    it.each([
      ['::ffff:127.0.0.1'],
      ['::ffff:7f00:1'],
      ['64:ff9b::a00:1'],
      ['2002:7f00:1::'],
      ['2001::1'],
      ['2001:0:4136:e378:8000:63bf:3fff:fdd2'],
      ['::127.0.0.1'],
      ['127.0.0.1'],
      ['10.0.0.1'],
      ['169.254.169.254'],
      ['100.64.0.1'],
      ['0.0.0.0'],
      ['255.255.255.255'],
      ['::1'],
      ['fe80::1'],
      ['fd00::1'],
      ['ff02::1'],
      ['2001:db8::1'],
      ['100::1'],
    ])('%s', async (ip) => {
      net.site(SITE, { '/': net.html('секрет') });
      net.dns.set(SITE, [ip]);
      await expect(
        pinnedFetch(`https://${SITE}/`, OPTS, net.deps()),
      ).rejects.toBeInstanceOf(SsrfBlockedError);
      expect(net.hits).toEqual([]);
      expect(net.dials).toEqual([]);
    });

    it('публичный + приватный в одном ответе — отказ (неизвестно, какой выберет сокет)', async () => {
      net.site(SITE, { '/': net.html('секрет') });
      net.dns.set(SITE, [PUBLIC_TEST_IP, '10.0.0.1']);
      await expect(
        pinnedFetch(`https://${SITE}/`, OPTS, net.deps()),
      ).rejects.toBeInstanceOf(SsrfBlockedError);
      expect(net.dials).toEqual([]);
    });
  });

  describe('адрес отвергается ДО резолва', () => {
    it.each([
      ['http://shop.ssrf.example/', 'http://'],
      ['https://shop.ssrf.example:8443/', 'нестандартный порт'],
      ['https://user:pass@shop.ssrf.example/', 'user:pass@'],
      ['http://2130706433/', 'http + десятичный IP'],
      ['https://2130706433/', 'десятичный IP'],
      ['https://0177.0.0.1/', 'восьмеричный IP'],
      ['https://0x7f.1/', 'hex-IP'],
      ['https://127.1/', 'сокращённый IP'],
      ['https://[::1]/', 'IPv6-литерал'],
      ['https://[::ffff:127.0.0.1]/', 'IPv4-mapped литерал'],
      ['https://localhost/', 'одноуровневое имя'],
      ['file:///etc/passwd', 'file://'],
    ])('%s (%s)', async (url) => {
      expect(() => assertCrawlableUrl(url)).toThrow(SsrfBlockedError);
      await expect(pinnedFetch(url, OPTS, net.deps())).rejects.toBeInstanceOf(
        SsrfBlockedError,
      );
      const fetcher = new PublicPageFetcher(
        new RobotsService(net.deps()),
        net.deps(),
      );
      const r = await fetcher.fetchPage(url, {
        purpose: 'assist-sandbox',
        db: memoryCacheDb(),
      });
      expect(r.ok).toBe(false);
      expect(['not_https', 'ssrf']).toContain(r.ok ? '' : r.reason);
      expect(net.lookups).toEqual([]);
      expect(net.hits).toEqual([]);
    });
  });

  describe('подресурсы: браузера нет, extractor не ходит в сеть', () => {
    it('страница с <img>/<script>/<iframe> на внутренние адреса — запрос только к самой странице', async () => {
      net.site(SITE, {
        '/robots.txt': { status: 404 },
        '/': net.html(
          `<main><p>Каталог</p><img src="http://10.0.0.1/p.gif"><img src="https://inner.ssrf.example/x.png">
           <script src="https://inner.ssrf.example/a.js"></script><iframe src="https://inner.ssrf.example/"></iframe>
           <link rel="stylesheet" href="https://inner.ssrf.example/s.css"></main>`,
        ),
      });
      net.dns.set('inner.ssrf.example', ['10.0.0.2']);
      const fetcher = new PublicPageFetcher(
        new RobotsService(net.deps()),
        net.deps(),
      );
      const r = await fetcher.fetchPage(`https://${SITE}/`, {
        purpose: 'assist-sandbox',
        db: memoryCacheDb(),
      });
      expect(r.ok).toBe(true);
      expect(net.hits).toEqual([`${SITE}/robots.txt`, `${SITE}/`]);
      expect(net.lookups.every((h) => h === SITE)).toBe(true);
    });
  });

  describe('проверка владения (файл/мета) — тоже через IP-pin', () => {
    it('хост владения резолвится в 127.0.0.1 — UNSAFE_URL, подключения нет', async () => {
      net.site(SITE, { '/': net.html('<meta name="v4c-verify" content="t">') });
      net.dns.set(SITE, ['127.0.0.1']);
      const http = {
        assertUrl: async () => undefined, // проверяет сам pin
        fetch: pinnedFetchLike(net.deps()),
        timeoutMs: 5000,
      };
      const r = await checkMeta(
        { scheme: 'https', host: SITE, port: 443 },
        't',
        http,
      );
      expect(r.code).toBe('UNSAFE_URL');
      expect(net.dials).toEqual([]);
      await expect(
        fetchSameOrigin(`https://${SITE}/`, http),
      ).rejects.toBeInstanceOf(UnsafeExternalUrlError);
    });

    it('по умолчанию проверка владения идёт через pinnedFetch, а не через глобальный fetch', async () => {
      const spy = jest.spyOn(global, 'fetch');
      try {
        // IP-литерал отвергается pin-ом ДО сети; глобальный fetch пошёл бы
        // подключаться к 127.0.0.1:443.
        await expect(
          DEFAULT_SAFE_HTTP_DEPS.fetch('https://127.0.0.1/', {}),
        ).rejects.toBeInstanceOf(UnsafeExternalUrlError);
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });

    it('публичный хост — мета находится (pin не ломает проверку владения)', async () => {
      net.site(SITE, {
        '/': { status: 302, headers: { location: '/uk/' } },
        '/uk/': net.html(
          '<html><head><meta name="v4c-verify" content="tok"></head></html>',
        ),
      });
      const http = {
        assertUrl: async () => undefined,
        fetch: pinnedFetchLike(net.deps()),
        timeoutMs: 5000,
      };
      const checker = new OwnershipChecker(new DohClient(), http);
      const r = await checker.check(
        'meta',
        { scheme: 'https', host: SITE, port: 443 },
        'tok',
      );
      expect(r.code).toBe('VERIFIED');
      expect(net.dials.every((d) => d.address === PUBLIC_TEST_IP)).toBe(true);
    });
  });
});
