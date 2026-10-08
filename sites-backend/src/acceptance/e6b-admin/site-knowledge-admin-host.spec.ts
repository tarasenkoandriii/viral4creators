/**
 * Инвариант «Админка → Сайт» для ЗНАНИЙ «Сайта» (Р-З9-24; ТЗ §10, К-9;
 * остаток (б) аудита Э6-бис (б)) на настоящем Postgres: хост, отмеченный
 * хостом «Админки» (`adminHostIds` → `site_hosts.assistRole = admin`,
 * триггер), знаниям «Сайта» не источник:
 *  - url-источник: адрес на admin-хосте — отказ при добавлении и при правке
 *    адресов (URL_ADMIN_HOST), горячие страницы — тоже; источник, добавленный
 *    ДО отметки, при разборе страницы admin-хоста не читает (`admin_host`);
 *    источник с живыми документами на admin-хосте тик разбора ставит в разбор
 *    сам: только admin-адреса — источник пуст (не DOCUMENT_NO_TEXT), сбой
 *    остальных страниц — admin-страницы всё равно сняты;
 *  - обход: «есть подтверждённый хост» — только хост «Сайта» (только
 *    admin-хост — HOST_ADMIN_ONLY, ничего — HOST_NOT_VERIFIED, обход не
 *    запрашивается); admin-хост — в исключениях прогона префиксом
 *    `https://хост/` (site-crawl о продукте не знает — crawl-product-neutral);
 *  - индексация: хост отметили ПОСЛЕ индексации и нового обхода нет — тик
 *    индексатора сам берёт сайт и снимает его страницы как исключённые (не
 *    «пропавшие»: версия не удерживается воротами «массово пропало»).
 */
import { SitesDb } from '../../prisma/sites-db.service';
import { describeDb } from '../../modules/assist-sandbox/testing/k3-stack.testing';
import { AssistCrawlScheduler } from '../../modules/assist-site-knowledge/crawl-scheduler.service';
import { SiteSourcesService } from '../../modules/assist-site-knowledge/site-sources.service';
import type { AccountMembership } from '../../modules/site-core/account/roles';
import { markAdminHosts } from '../../modules/site-core/testing/admin-hosts.testing';
import type { SiteCrawlService } from '../../modules/site-crawl/crawl.service';
import {
  Harness,
  createSite,
  crawl,
  indexSite,
  type SiteFixture,
} from '../e1/k2-fixtures';

jest.setTimeout(120_000);

type CrawlRequest = Parameters<SiteCrawlService['requestRun']>[0];
const MONTH = 30 * 86_400_000;

describeDb(
  'Инвариант «Админка → Сайт»: знания «Сайта» и хост «Админки»',
  () => {
    let h: Harness;
    let sources: SiteSourcesService;
    let scheduler: AssistCrawlScheduler;
    const runs: CrawlRequest[] = [];
    const fetched: string[] = [];
    /** Адреса, которые «сайт» сейчас не отдаёт (5xx). */
    const down = new Set<string>();

    beforeAll(() => {
      h = new Harness();
      const db = new SitesDb(h.prisma);
      const crawlStub = {
        requestRun: async (r: CrawlRequest) => {
          runs.push(r);
          return { runId: `run-${runs.length}`, deduplicated: false };
        },
        latestRun: async () => null,
        getRun: async () => null,
      } as unknown as SiteCrawlService;
      const fetcher = {
        fetchPage: async (url: string) => {
          fetched.push(url);
          if (down.has(url)) return { ok: false, reason: 'http_5xx' };
          return {
            ok: true,
            httpStatus: 200,
            etag: null,
            lastModified: null,
            page: {
              url,
              title: 'Сторінка',
              lang: 'uk',
              blocks: [
                { t: 'h', level: 1, text: 'Доставка', path: [] },
                {
                  t: 'p',
                  text: `Доставка Новою поштою за 1–2 дні (${url}).`,
                  path: ['Доставка'],
                },
              ],
            },
          };
        },
      };
      const hosts = { assertHostVerified: async () => undefined };
      scheduler = new AssistCrawlScheduler(db, crawlStub);
      sources = new SiteSourcesService(
        db,
        h.site,
        null as never,
        fetcher as never,
        hosts as never,
        crawlStub,
        h.budget,
        scheduler,
        null as never,
        h.usage,
      );
    });
    afterAll(async () => {
      await h?.close();
    });

    const owner = (s: SiteFixture): AccountMembership => ({
      accountId: s.accountId,
      memberId: 'm',
      telegramId: s.ownerTelegramId,
      role: 'owner',
      productRoles: { qa: 'admin', assist: 'manager', assistAdmin: 'owner' },
    });

    /** Сайт с хостом «Сайта» и вторым хостом (будущий хост «Админки»), оба подтверждены. */
    async function twoHosts(): Promise<{
      s: SiteFixture;
      adm: { id: string; host: string; origin: string };
    }> {
      const s = await createSite(h);
      const host = `adm-${s.siteId.slice(-8)}.example.com`;
      const row = await h.prisma.siteHost.create({
        data: {
          accountId: s.accountId,
          siteId: s.siteId,
          host,
          status: 'verified',
          method: 'dns',
          verifiedAt: new Date(),
        },
      });
      await h.prisma.siteHost.updateMany({
        where: { siteId: s.siteId },
        data: { expiresAt: new Date(Date.now() + MONTH) },
      });
      return { s, adm: { id: row.id, host, origin: `https://${host}` } };
    }

    /** Код ошибки (HttpException: тело `{ code, … }`). */
    const code = (e: unknown) =>
      (
        (e as { getResponse?: () => unknown }).getResponse?.() as
          { code?: string } | undefined
      )?.code;
    const failure = (p: Promise<unknown>) =>
      p.then(
        () => null,
        (e: unknown) => e,
      );

    it('url-источник: адрес на admin-хосте — URL_ADMIN_HOST при добавлении и правке, горячие страницы — тоже; хост «Сайта» — как раньше; снятие отметки возвращает хост', async () => {
      const { s, adm } = await twoHosts();
      await markAdminHosts(h.prisma, s, [adm.id]);
      const m = owner(s);
      const refused = await failure(
        sources.core.createSource(m, s.siteId, {
          kind: 'url',
          urls: [`${s.origin}/delivery`, `${adm.origin}/orders`],
        }),
      );
      expect(code(refused)).toBe('URL_ADMIN_HOST');
      expect((refused as Error).message).toContain('«Админке»');
      expect(
        await h.prisma.assistSiteSource.count({
          where: { siteId: s.siteId, kind: 'url' },
        }),
      ).toBe(0);
      const ok = await sources.core.createSource(m, s.siteId, {
        kind: 'url',
        urls: [`${s.origin}/delivery`],
      });
      expect(
        code(
          await failure(
            sources.core.patchSource(m, s.siteId, ok.source.id, {
              urls: [`${adm.origin}/orders`],
            }),
          ),
        ),
      ).toBe('URL_ADMIN_HOST');
      expect(
        code(
          await failure(
            sources.setHotPages(m, s.siteId, [`${adm.origin}/orders`]),
          ),
        ),
      ).toBe('URL_ADMIN_HOST');
      // Хост вернули «Сайту» — снова можно.
      await markAdminHosts(h.prisma, s, []);
      await sources.core.patchSource(m, s.siteId, ok.source.id, {
        urls: [`${adm.origin}/orders`],
      });
    });

    it('url-источник, добавленный до отметки: при разборе страница admin-хоста не читается (`admin_host`), страница «Сайта» — в знаниях', async () => {
      const { s, adm } = await twoHosts();
      const m = owner(s);
      const { source } = await sources.core.createSource(m, s.siteId, {
        kind: 'url',
        urls: [`${s.origin}/delivery`, `${adm.origin}/orders`],
      });
      await markAdminHosts(h.prisma, s, [adm.id]);
      const row = await h.prisma.assistSiteSource.findUniqueOrThrow({
        where: { id: source.id },
      });
      fetched.length = 0;
      // Разбор ОДНОГО источника (крон `processPending` идёт по всем кабинетам
      // общей базы — чужие источники этому набору трогать нельзя).
      await (
        sources.core as unknown as {
          processOne(r: unknown, attempt: number, now: Date): Promise<void>;
        }
      ).processOne(row, 1, new Date());
      expect(fetched).toEqual([`${s.origin}/delivery`]);
      const after = await h.prisma.assistSiteSource.findUniqueOrThrow({
        where: { id: source.id },
      });
      expect(after.status).toBe('active');
      expect(after.documentsCount).toBe(1);
      expect(after.config).toMatchObject({
        skipped: [{ url: `${adm.origin}/orders`, reason: 'admin_host' }],
      });
    });

    it('обход: только admin-хост подтверждён — HOST_ADMIN_ONLY (ничего — HOST_NOT_VERIFIED), обход не запрошен; есть хост «Сайта» — admin-хост в исключениях прогона рядом с исключениями владельца', async () => {
      const { s, adm } = await twoHosts();
      const m = owner(s);
      await markAdminHosts(h.prisma, s, [adm.id]);
      await h.prisma.assistSiteExclusion.create({
        data: {
          accountId: s.accountId,
          siteId: s.siteId,
          kind: 'urlPrefix',
          value: `${s.origin}/private/`,
          createdByTelegramId: s.ownerTelegramId,
        },
      });
      expect((await sources.settingsView(m, s.siteId)).hasVerifiedHost).toBe(
        true,
      );
      runs.length = 0;
      await sources.recrawl(m, s.siteId).catch(() => undefined);
      // Только поля стыка (в запросе есть BigInt — jest его не сериализует).
      const mine = runs
        .filter((r) => r.siteId === s.siteId)
        .map(({ product, mode, excludePrefixes }) => ({
          product,
          mode,
          excludePrefixes,
        }));
      expect(mine).toEqual([
        {
          product: 'assist',
          mode: 'full',
          excludePrefixes: [`${s.origin}/private/`, `${adm.origin}/`],
        },
      ]);
      // Хост «Сайта» потерял подтверждение — admin-хост обход не оправдывает.
      await h.prisma.siteHost.update({
        where: { id: s.hostId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      expect((await sources.settingsView(m, s.siteId)).hasVerifiedHost).toBe(
        false,
      );
      runs.length = 0;
      // P3-1: подсказка — не «подтвердите хост», а «добавьте хост сайта».
      expect(code(await failure(sources.recrawl(m, s.siteId)))).toBe(
        'HOST_ADMIN_ONLY',
      );
      // Первый обход после подтверждения и вебхук — отказ планировщика.
      expect(
        code(
          await failure(
            scheduler.requestNow({
              accountId: s.accountId,
              siteId: s.siteId,
              trigger: 'webhook',
            }),
          ),
        ),
      ).toBe('HOST_NOT_VERIFIED');
      // Не подтверждено ничего — прежний код.
      await h.prisma.siteHost.update({
        where: { id: adm.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      expect(code(await failure(sources.recrawl(m, s.siteId)))).toBe(
        'HOST_NOT_VERIFIED',
      );
      expect(runs.filter((x) => x.siteId === s.siteId)).toEqual([]);
    });

    it('индексация: хост отметили ПОСЛЕ индексации, нового обхода нет (подтверждён только admin-хост) — тик индексатора сам берёт сайт; страницы admin-хоста — исключены, версия публикуется (не «массово пропало»), страницы «Сайта» живы; повторно сайт не берётся', async () => {
      const { s, adm } = await twoHosts();
      const admSite: SiteFixture = { ...s, hostId: adm.id, origin: adm.origin };
      const page = (path: string, word: string) => ({
        path,
        title: path,
        paragraphs: [`${word}: умови та строки для покупців магазину.`],
      });
      await crawl(h, s, [page('/a', 'Доставка'), page('/b', 'Оплата')]);
      await crawl(h, admSite, [
        page('/orders', 'Замовлення'),
        page('/clients', 'Клієнти'),
      ]);
      const first = await indexSite(h, s);
      expect(first?.version?.status).toBe('published');
      const docs = () =>
        h.prisma.assistSiteDocument.findMany({
          where: { siteId: s.siteId },
          select: { url: true, status: true, skipReason: true },
          orderBy: { url: 'asc' },
        });
      expect((await docs()).map((d) => d.status)).toEqual([
        'active',
        'active',
        'active',
        'active',
      ]);
      const mine = async () =>
        (await h.siteIndexing.candidates(10_000)).some(
          (c) => c.siteId === s.siteId,
        );
      expect(await mine()).toBe(false);
      // Отметка ПОСЛЕ индексации; хост «Сайта» не подтверждён — обхода не будет.
      await markAdminHosts(h.prisma, s, [adm.id]);
      await h.prisma.siteHost.update({
        where: { id: s.hostId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      expect(await mine()).toBe(true);
      const second = await indexSite(h, s);
      expect(second?.version?.status).toBe('published');
      const byUrl = Object.fromEntries(
        (await docs()).map((d) => [d.url, [d.status, d.skipReason]]),
      );
      expect(byUrl).toEqual({
        [`${adm.origin}/clients`]: ['skipped', 'excluded'],
        [`${adm.origin}/orders`]: ['skipped', 'excluded'],
        [`${s.origin}/a`]: ['active', null],
        [`${s.origin}/b`]: ['active', null],
      });
      // В опубликованной версии фрагментов admin-хоста нет.
      const site = await h.prisma.assistSite.findUniqueOrThrow({
        where: { siteId: s.siteId },
      });
      const chunks = await h.prisma.assistSiteChunk.findMany({
        where: { siteId: s.siteId, versions: { has: site.knowledgeVersion } },
        select: { url: true },
      });
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks.every((c) => !String(c.url).startsWith(adm.origin))).toBe(
        true,
      );
      // Сняли — тик сайт больше не берёт (без новых версий каждый тик).
      expect(await mine()).toBe(false);
    });

    /** url-источник, разобранный, пока хост был хостом «Сайта». */
    async function urlSourceIndexed(urls: (o: string, a: string) => string[]) {
      const { s, adm } = await twoHosts();
      const m = owner(s);
      const { source } = await sources.core.createSource(m, s.siteId, {
        kind: 'url',
        urls: urls(s.origin, adm.origin),
      });
      await processOne(source.id);
      const docs = () =>
        h.prisma.assistSiteDocument.findMany({
          where: { sourceId: source.id },
          select: { url: true, status: true },
          orderBy: { url: 'asc' },
        });
      expect((await docs()).every((d) => d.status === 'active')).toBe(true);
      return { s, adm, sourceId: source.id, docs };
    }
    async function processOne(sourceId: string) {
      const row = await h.prisma.assistSiteSource.findUniqueOrThrow({
        where: { id: sourceId },
      });
      await (
        sources.core as unknown as {
          processOne(r: unknown, attempt: number, now: Date): Promise<void>;
        }
      ).processOne(row, 1, new Date());
      return h.prisma.assistSiteSource.findUniqueOrThrow({
        where: { id: sourceId },
      });
    }

    it('url-источник только с адресом admin-хоста, хост отметили ПОСЛЕ публикации: тик разбора ставит источник в разбор, разбор снимает страницу (источник пуст, не DOCUMENT_NO_TEXT), повторно не ставит', async () => {
      const { s, adm, sourceId, docs } = await urlSourceIndexed((_o, a) => [
        `${a}/orders`,
      ]);
      await markAdminHosts(h.prisma, s, [adm.id]);
      expect(await sources.requeueAdminHostSources()).toBeGreaterThanOrEqual(1);
      const queued = await h.prisma.assistSiteSource.findUniqueOrThrow({
        where: { id: sourceId },
      });
      expect([queued.status, queued.attempts, queued.lockedUntil]).toEqual([
        'processing',
        0,
        null,
      ]);
      fetched.length = 0;
      const after = await processOne(sourceId);
      expect(fetched).toEqual([]);
      expect([after.status, after.documentsCount]).toEqual(['active', 0]);
      expect(await docs()).toEqual([
        { url: `${adm.origin}/orders`, status: 'gone' },
      ]);
      await sources.requeueAdminHostSources();
      expect(
        (
          await h.prisma.assistSiteSource.findUniqueOrThrow({
            where: { id: sourceId },
          })
        ).status,
      ).toBe('active');
    });

    it('url-источник: страница «Сайта» не прочиталась (5xx), а вторая — на хосте, отданном «Админке»: сбой разбора, но страница admin-хоста из знаний снята, страница «Сайта» — нет', async () => {
      const { s, adm, sourceId, docs } = await urlSourceIndexed((o, a) => [
        `${o}/delivery`,
        `${a}/orders`,
      ]);
      await markAdminHosts(h.prisma, s, [adm.id]);
      down.add(`${s.origin}/delivery`);
      try {
        const after = await processOne(sourceId);
        expect(after.status).toBe('failed');
      } finally {
        down.delete(`${s.origin}/delivery`);
      }
      expect(
        Object.fromEntries((await docs()).map((d) => [d.url, d.status])),
      ).toEqual({
        [`${s.origin}/delivery`]: 'active',
        [`${adm.origin}/orders`]: 'gone',
      });
    });
  },
);
