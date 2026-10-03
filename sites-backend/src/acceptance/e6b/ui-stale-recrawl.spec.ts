/**
 * Решение владельца 03.10.2026 п.4 (Э6-бис (г)) на реальном Postgres:
 * точечный переобход страницы, элементы карты которой устарели (Ш4), —
 * только эта страница (`hot`, одна страница), ≤ 1 раза в сутки на страницу
 * и только если элемент устарел ПОСЛЕ прошлого переобхода, ≤ N страниц в
 * сутки на сайт по тарифу (Start 0, Business 5, Pro 20), за счёт бюджета
 * знаний (исчерпан — `budget`, обхода нет), журнал и сводка в кабинете.
 */
import { setPlan } from '../../modules/assist-billing/testing/billing-fixtures.testing';
import { describeDb } from '../../modules/assist-sandbox/testing/k3-stack.testing';
import {
  ChatStack,
  type ChatSite,
} from '../../modules/assist-site-chat/testing/chat-stack.testing';
import { AssistCrawlScheduler } from '../../modules/assist-site-knowledge/crawl-scheduler.service';
import { UI_STALE_RECRAWL } from '../../modules/assist-site-knowledge/ui-stale-recrawl-config';
import { SiteVideosService } from '../../modules/assist-site-media/cabinet/site-videos.service';
import type { LearningBudget } from '../../modules/site-ai/learning-budget';
import type { SiteCrawlService } from '../../modules/site-crawl/crawl.service';

type CrawlRequest = Parameters<SiteCrawlService['requestRun']>[0];
import type { AccountMembership } from '../../modules/site-core/account/roles';
import { SitesDb } from '../../prisma/sites-db.service';

jest.setTimeout(120_000);

describeDb(
  'Решение п.4: точечный переобход страниц с устаревшей картой',
  () => {
    const st = new ChatStack();
    let scheduler: AssistCrawlScheduler;
    const runs: CrawlRequest[] = [];
    let exhausted = new Set<string>();
    const mine = new Set<string>();

    beforeAll(async () => {
      await st.init();
      const crawl = {
        requestRun: async (r: CrawlRequest) => {
          runs.push(r);
          return { runId: `run-${runs.length}`, deduplicated: false };
        },
      };
      const budget = {
        status: async (_a: string, siteId: string) => ({
          period: '2026-10',
          capMicroUsd: 1_000_000,
          spentMicroUsd: exhausted.has(siteId) ? 1_000_000 : 0,
        }),
      } as unknown as LearningBudget;
      scheduler = new AssistCrawlScheduler(
        new SitesDb(st.owner),
        crawl as never,
        budget,
      );
    });
    afterAll(async () => {
      await st.close();
    });
    beforeEach(() => {
      runs.length = 0;
      exhausted = new Set();
    });

    async function staleSite(
      plan: 'business' | 'start' | 'pro',
      pages: string[],
      staleAt = new Date(),
    ): Promise<ChatSite> {
      const s = await st.site();
      mine.add(s.siteId);
      await setPlan(st.owner, s.accountId, plan);
      await st.owner.siteHost.updateMany({
        where: { siteId: s.siteId },
        data: { expiresAt: new Date(Date.now() + 30 * 86_400_000) },
      });
      const host = await st.owner.siteHost.findFirst({
        where: { siteId: s.siteId },
      });
      for (const [i, path] of pages.entries())
        await st.owner.siteUiElement.create({
          data: {
            accountId: s.accountId,
            siteId: s.siteId,
            hostId: host!.id,
            host: s.host,
            path,
            viewport: 'desktop',
            elementKey: `text:кнопка-${i}`,
            elementId: `el-${i}`,
            tag: 'button',
            label: `Кнопка ${i}`,
            selector: `button.b${i}`,
            candidates: [],
            stability: 'medium',
            confidence: 50,
            sources: ['crawl'],
            sourceRank: 4,
            position: 0,
            firstSeenAt: new Date(),
            lastSeenAt: new Date(),
            staleDesktopAt: staleAt,
          },
        });
      return s;
    }

    const ours = (s: ChatSite) => runs.filter((r) => r.siteId === s.siteId);

    it('Business: только устаревшая страница, `hot` одной страницей; повтор в те же сутки — нет', async () => {
      const s = await staleSite('business', ['/catalog']);
      await scheduler.scheduleStaleUiPages(new Date());
      expect(ours(s)).toEqual([
        expect.objectContaining({
          mode: 'hot',
          maxPages: 1,
          urls: [`https://${s.host}/catalog`],
          product: 'assist',
        }),
      ]);
      const j = await st.owner.assistSiteUiRecrawl.findMany({
        where: { siteId: s.siteId },
      });
      expect(j).toEqual([
        expect.objectContaining({
          path: '/catalog',
          status: 'requested',
          staleElements: 1,
          // Номер обхода — по месту в проходе (в общей базе могут быть
          // устаревшие страницы прошлых прогонов).
          runId: `run-${runs.indexOf(ours(s)[0]) + 1}`,
        }),
      ]);
      runs.length = 0;
      await scheduler.scheduleStaleUiPages(new Date());
      expect(ours(s)).toEqual([]);
      // Через сутки, но элемент устарел ДО прошлого переобхода — тоже нет.
      await scheduler.scheduleStaleUiPages(
        new Date(Date.now() + 25 * 3_600_000),
      );
      expect(ours(s)).toEqual([]);
    });

    it('лимит страниц в сутки по тарифу: Business 5 из 7; Start — 0', async () => {
      const b = await staleSite('business', [
        '/a',
        '/b',
        '/c',
        '/d',
        '/e',
        '/f',
        '/g',
      ]);
      const st0 = await staleSite('start', ['/x']);
      await scheduler.scheduleStaleUiPages(new Date());
      expect(ours(b)).toHaveLength(UI_STALE_RECRAWL.pagesPerDayByPlan.business);
      expect(ours(st0)).toEqual([]);
    });

    it('бюджет знаний исчерпан — обхода нет, журнал `budget`', async () => {
      const s = await staleSite('pro', ['/p']);
      exhausted.add(s.siteId);
      await scheduler.scheduleStaleUiPages(new Date());
      expect(ours(s)).toEqual([]);
      const j = await st.owner.assistSiteUiRecrawl.findMany({
        where: { siteId: s.siteId },
      });
      expect(j.map((x) => x.status)).toEqual(['budget']);
    });

    it('аудит (г) 03.10: сайты, упёршиеся в суточный лимит, не занимают выборку — следующий сайт переобходится', async () => {
      // Много сайтов Start (лимит 0) с устаревшими страницами и один Business:
      // при выборке пачками по 1 странице без дочитывания Business не
      // дождался бы своей очереди.
      for (let i = 0; i < 5; i++) await staleSite('start', ['/s1', '/s2']);
      const b = await staleSite('business', ['/late']);
      const cfg = UI_STALE_RECRAWL as { scanBatch: number };
      const prev = cfg.scanBatch;
      cfg.scanBatch = 1;
      try {
        await scheduler.scheduleStaleUiPages(new Date());
      } finally {
        cfg.scanBatch = prev;
      }
      expect(ours(b)).toEqual([
        expect.objectContaining({ urls: [`https://${b.host}/late`] }),
      ]);
    });

    it('аудит (г) 03.10: путь страницы не абсолютный — обхода нет (адрес не уйдёт на чужой хост)', async () => {
      const s = await staleSite('pro', ['@evil.example.org/x']);
      await scheduler.scheduleStaleUiPages(new Date());
      expect(ours(s)).toEqual([]);
    });

    it('сводка в кабинете: лимит тарифа, сегодня, последние записи', async () => {
      const s = await staleSite('business', ['/one']);
      await scheduler.scheduleStaleUiPages(new Date());
      const svc = new SiteVideosService(new SitesDb(st.owner), st.owner);
      const m: AccountMembership = {
        accountId: s.accountId,
        memberId: 'm',
        telegramId: s.ownerTelegramId,
        role: 'owner',
        productRoles: { qa: 'admin', assist: 'manager', assistAdmin: 'owner' },
      };
      const v = await svc.uiMap(m, s.siteId);
      expect(v.recrawl).toMatchObject({ perDay: 5, today: 1 });
      expect(v.recrawl!.recent[0]).toMatchObject({
        path: '/one',
        status: 'requested',
      });
    });
  },
);
