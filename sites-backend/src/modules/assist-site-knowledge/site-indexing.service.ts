/**
 * Конвейер индексации «Сайта» — K2 (крон assist-embed-run, §4.15):
 * завершённые прогоны обхода (site_crawl_runs product=assist, status done,
 * id ≠ assist_sites.lastIndexedCrawlRunId) → документы источника `crawl`
 * из site_pages (изменённые по contentHash ≠ indexedHash, новые, gone) →
 * версия через ворота аномалий (+ инвариантный eval, если хватает
 * бюджета обучения) → published | held (+ уведомление владельцу,
 * held-notifier.ts). Исключения (assist_site_exclusions) применяются до
 * индексации: исключённое не возвращается. Prune окна отката — там же
 * (KnowledgeIndexer.afterPublish).
 *
 * Снимок, а не «страницы прогона»: индексация читает ВСЕ страницы сайта
 * из site_pages (их пишет только обход). Так горячий прогон (5 страниц)
 * и полный (500) обрабатываются одинаково, а страница, которую прогон не
 * трогал, остаётся как была.
 */
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SitesDb } from '../../prisma/sites-db.service';
import { qualified } from '../assist-knowledge-core/tables';
import { SiteKnowledgeService } from './site-knowledge.service';
import { SITE_TABLES } from './site-tables';

export interface IndexTickResult {
  sitesTouched: number;
  versionsCreated: number;
  versionsHeld: number;
  chunksEmbedded: number;
  chunksReused: number;
  budgetExhausted: boolean;
}

/** Сайтов за тик — не больше (остальные — следующим тиком). */
const SITES_PER_TICK = 20;

interface Candidate {
  runId: string;
  siteId: string;
  accountId: string;
  hotPages: string[];
}

@Injectable()
export class SiteIndexingService {
  private readonly logger = new Logger(SiteIndexingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sitesDb: SitesDb,
    private readonly knowledge: SiteKnowledgeService,
  ) {}

  /** Сайты с непроиндексированным последним завершённым прогоном. */
  async candidates(limit = SITES_PER_TICK): Promise<Candidate[]> {
    // Крон идёт по всем кабинетам; accountId каждой строки берётся из
    // самой строки и дальше идёт в каждый запрос (SitesDb.forAccount).
    return this.prisma.$queryRawUnsafe<Candidate[]>(
      `SELECT * FROM (
         SELECT DISTINCT ON (r."siteId")
                r."id" AS "runId", r."siteId", r."accountId", a."hotPages",
                a."lastIndexedCrawlRunId", r."finishedAt"
           FROM ${qualified('site_crawl_runs')} r
           JOIN ${qualified(SITE_TABLES.settings)} a
             ON a."siteId" = r."siteId" AND a."accountId" = r."accountId"
          WHERE r."product" = 'assist' AND r."status" = 'done' AND a."enabled"
          ORDER BY r."siteId", r."finishedAt" DESC NULLS LAST, r."createdAt" DESC
       ) x
       WHERE x."lastIndexedCrawlRunId" IS DISTINCT FROM x."runId"
       ORDER BY x."finishedAt" ASC NULLS FIRST
       LIMIT $1`,
      limit,
    );
  }

  private async crawlSourceId(
    accountId: string,
    siteId: string,
  ): Promise<string> {
    const db = this.sitesDb.forAccount(accountId);
    const found = await db.assistSiteSource.findFirst({
      where: { siteId, kind: 'crawl' },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
    if (found) return found.id;
    const created = await db.assistSiteSource.create({
      data: { accountId, siteId, kind: 'crawl', status: 'active' },
      select: { id: true },
    });
    return created.id;
  }

  async indexSite(c: Candidate) {
    const ctx = { accountId: c.accountId, siteId: c.siteId };
    const db = this.sitesDb.forAccount(c.accountId);
    const sourceId = await this.crawlSourceId(c.accountId, c.siteId);
    const pages = await db.sitePage.findMany({
      where: { siteId: c.siteId },
      select: {
        id: true,
        url: true,
        finalUrl: true,
        status: true,
        skipReason: true,
        title: true,
        lang: true,
        blocks: true,
        contentHash: true,
      },
    });
    const out = await this.knowledge.engine.indexCrawl(ctx, {
      sourceId,
      crawlRunId: c.runId,
      pages,
      hotUrls: c.hotPages ?? [],
      includeUgc: true,
    });
    if (out.busy) return out;
    await db.assistSite.updateMany({
      where: { siteId: c.siteId },
      data: { lastIndexedCrawlRunId: c.runId },
    });
    const documentsCount = await db.assistSiteDocument.count({
      where: { sourceId, status: 'active' },
    });
    await db.assistSiteSource.updateMany({
      where: { id: sourceId },
      data: { documentsCount, lastSyncAt: new Date() },
    });
    return out;
  }

  async tick(budgetMs: number): Promise<IndexTickResult> {
    const deadline = Date.now() + budgetMs;
    const res: IndexTickResult = {
      sitesTouched: 0,
      versionsCreated: 0,
      versionsHeld: 0,
      chunksEmbedded: 0,
      chunksReused: 0,
      budgetExhausted: false,
    };
    for (const c of await this.candidates()) {
      if (Date.now() >= deadline) break;
      try {
        const out = await this.indexSite(c);
        if (out.busy) continue;
        res.sitesTouched++;
        if (out.version) res.versionsCreated++;
        if (out.version?.status === 'held') res.versionsHeld++;
        res.chunksEmbedded += out.embedded;
        res.chunksReused += out.reused;
        res.budgetExhausted ||= out.budgetExhausted;
      } catch (e) {
        // Один сломанный сайт не останавливает остальные; прогон не
        // отмечен проиндексированным — повторится следующим тиком.
        this.logger.error(
          `Индексация сайта ${c.siteId} не удалась: ${(e as Error).message}`,
        );
      }
    }
    return res;
  }
}
