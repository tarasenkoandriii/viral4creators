/**
 * Расписание обхода помощника — K1 (§3.4, §4-тер.2, §4.15 assist-crawl-run):
 * сайты с assist_sites.enabled и наступившим nextCrawlAt (weekly/daily;
 * manual — только по кнопке) → SiteCrawlService.requestRun(mode full,
 * maxPages — «страниц в знаниях» тарифа кабинета (Э4, assist-billing/limits),
 * исключения url/urlPrefix из
 * assist_site_exclusions); «горячие страницы» — ежедневно на всех
 * тарифах (mode hot, условный запрос), в том числе у сайтов с ручным
 * переобходом. Сам обход делает SiteCrawlService.tick (зовёт крон).
 *
 * Полный обход — только если у сайта есть verified-хост; нет — сайт на
 * этапе песочницы: ничего не запрашиваем и смотрим снова через час (хост
 * могли подтвердить — первый обход начнётся без отдельного хука).
 *
 * site-crawl о продукте не знает (правило графа crawl-product-neutral):
 * «когда обходить» и `assist_sites.lastCrawlRunId` — здесь.
 */
import { Injectable, Logger, ConflictException } from '@nestjs/common';
import { CRAWL_DEFAULTS } from '../../config/assist-defaults';
import { crawlMaxPages } from '../assist-billing/limits';
import { SitesDb } from '../../prisma/sites-db.service';
import { siteCoreError } from '../site-core/site-core.constants';
import { evaluateHostAccess } from '../site-core/ownership/host-access';
import { SiteCrawlService } from '../site-crawl/crawl.service';

export interface CrawlScheduleResult {
  runsRequested: number;
  hotRunsRequested: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Нет подтверждённого хоста — заглянуть снова через… */
const NO_HOST_RETRY_MS = 60 * 60 * 1000;
/** Сайтов за один вызов крона (каждый — пара запросов к базе). */
const SCHEDULE_BATCH = 50;

export function recrawlIntervalMs(every: string): number | null {
  if (every === 'daily') return DAY_MS;
  if (every === 'weekly') return 7 * DAY_MS;
  return null;
}

@Injectable()
export class AssistCrawlScheduler {
  private readonly logger = new Logger(AssistCrawlScheduler.name);

  constructor(
    private readonly sitesDb: SitesDb,
    private readonly crawl: SiteCrawlService,
  ) {}

  async scheduleDue(now: Date): Promise<CrawlScheduleResult> {
    const sys = this.sitesDb.system(
      'расписание обхода: сайты помощника всех кабинетов',
    );
    const out: CrawlScheduleResult = { runsRequested: 0, hotRunsRequested: 0 };

    const due = await sys.assistSite.findMany({
      where: {
        enabled: true,
        recrawlEvery: { in: ['weekly', 'daily'] },
        OR: [{ nextCrawlAt: null }, { nextCrawlAt: { lte: now } }],
      },
      orderBy: { nextCrawlAt: { sort: 'asc', nulls: 'first' } },
      take: SCHEDULE_BATCH,
    });
    for (const s of due) {
      try {
        if (!(await this.hasVerifiedHost(s.accountId, s.siteId, now))) {
          await this.sitesDb.forAccount(s.accountId).assistSite.updateMany({
            where: { siteId: s.siteId },
            data: { nextCrawlAt: new Date(now.getTime() + NO_HOST_RETRY_MS) },
          });
          continue;
        }
        const { runId, deduplicated } = await this.crawl.requestRun({
          accountId: s.accountId,
          siteId: s.siteId,
          product: 'assist',
          trigger: 'schedule',
          mode: 'full',
          maxPages: await this.maxPages(s.accountId, now),
          ...(await this.exclusions(s.accountId, s.siteId)),
        });
        const every = recrawlIntervalMs(s.recrawlEvery) ?? 7 * DAY_MS;
        await this.sitesDb.forAccount(s.accountId).assistSite.updateMany({
          where: { siteId: s.siteId },
          data: {
            nextCrawlAt: new Date(now.getTime() + every),
            lastCrawlRunId: runId,
          },
        });
        if (!deduplicated) out.runsRequested++;
      } catch (e) {
        // Один сломанный сайт не должен остановить расписание остальных.
        this.logger.error(`расписание обхода ${s.siteId}: ${String(e)}`);
      }
    }

    const hot = await sys.assistSite.findMany({
      where: {
        enabled: true,
        NOT: { hotPages: { isEmpty: true } },
        OR: [
          { hotCheckedAt: null },
          { hotCheckedAt: { lte: new Date(now.getTime() - DAY_MS) } },
        ],
      },
      orderBy: { hotCheckedAt: { sort: 'asc', nulls: 'first' } },
      take: SCHEDULE_BATCH,
    });
    for (const s of hot) {
      try {
        const db = this.sitesDb.forAccount(s.accountId);
        // Отметка — до запроса: сломанный список не должен дёргаться каждые 2 минуты.
        await db.assistSite.updateMany({
          where: { siteId: s.siteId },
          data: { hotCheckedAt: now },
        });
        if (!(await this.hasVerifiedHost(s.accountId, s.siteId, now))) continue;
        const urls = s.hotPages.slice(0, CRAWL_DEFAULTS.maxHotPages);
        const { deduplicated } = await this.crawl.requestRun({
          accountId: s.accountId,
          siteId: s.siteId,
          product: 'assist',
          trigger: 'hot',
          mode: 'hot',
          maxPages: Math.max(urls.length, 1),
          urls,
          ...(await this.exclusions(s.accountId, s.siteId)),
        });
        if (!deduplicated) out.hotRunsRequested++;
      } catch (e) {
        this.logger.error(`горячие страницы ${s.siteId}: ${String(e)}`);
      }
    }
    return out;
  }

  /** Лимит страниц обхода — «страниц в знаниях» тарифа кабинета (§7.1). */
  private maxPages(accountId: string, now: Date): Promise<number> {
    return crawlMaxPages(
      this.sitesDb.system('тариф кабинета — лимит страниц обхода (§7.1)'),
      accountId,
      now,
    );
  }

  /** Ручной «переобойти» и первый обход после подтверждения хоста (K3 зовёт). */
  async requestNow(p: {
    accountId: string;
    siteId: string;
    trigger: 'initial' | 'manual' | 'webhook';
    byTelegramId?: bigint | null;
  }): Promise<{ runId: string; deduplicated: boolean }> {
    const now = new Date();
    if (!(await this.hasVerifiedHost(p.accountId, p.siteId, now))) {
      throw siteCoreError(
        ConflictException,
        'HOST_NOT_VERIFIED',
        'Подтвердите владение хотя бы одним адресом сайта — без этого обход невозможен',
      );
    }
    const result = await this.crawl.requestRun({
      accountId: p.accountId,
      siteId: p.siteId,
      product: 'assist',
      trigger: p.trigger,
      mode: 'full',
      maxPages: await this.maxPages(p.accountId, now),
      requestedByTelegramId: p.byTelegramId ?? undefined,
      ...(await this.exclusions(p.accountId, p.siteId)),
    });
    const db = this.sitesDb.forAccount(p.accountId);
    const settings = await db.assistSite.findFirst({
      where: { siteId: p.siteId },
      select: { recrawlEvery: true },
    });
    if (settings) {
      const every = recrawlIntervalMs(settings.recrawlEvery);
      await db.assistSite.updateMany({
        where: { siteId: p.siteId },
        data: {
          lastCrawlRunId: result.runId,
          // Следующий плановый — от этого обхода, а не от старого расписания.
          nextCrawlAt: every === null ? null : new Date(now.getTime() + every),
        },
      });
    }
    return result;
  }

  private async hasVerifiedHost(
    accountId: string,
    siteId: string,
    now: Date,
  ): Promise<boolean> {
    const hosts = await this.sitesDb
      .forAccount(accountId)
      .siteHost.findMany({ where: { siteId } });
    return hosts.some(
      (h) =>
        h.scheme === 'https' &&
        h.port === 443 &&
        evaluateHostAccess(h, 'assist-crawl', now).ok,
    );
  }

  /** Исключения «Сайта» (§4-тер.12): переобход их не берёт. */
  private async exclusions(
    accountId: string,
    siteId: string,
  ): Promise<{ excludePrefixes?: string[]; excludeUrls?: string[] }> {
    const rows = await this.sitesDb
      .forAccount(accountId)
      .assistSiteExclusion.findMany({
        where: { siteId, kind: { in: ['url', 'urlPrefix'] } },
        select: { kind: true, value: true },
      });
    const excludeUrls = rows
      .filter((r) => r.kind === 'url')
      .map((r) => r.value);
    const excludePrefixes = rows
      .filter((r) => r.kind === 'urlPrefix')
      .map((r) => r.value);
    return {
      ...(excludeUrls.length ? { excludeUrls } : {}),
      ...(excludePrefixes.length ? { excludePrefixes } : {}),
    };
  }
}
