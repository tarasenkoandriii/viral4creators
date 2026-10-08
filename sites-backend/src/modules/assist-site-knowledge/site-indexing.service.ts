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
 * Э2 (W5) — сборка с дедлайном тика: indexCrawl получает дедлайн, большой
 * сайт собирается пачками за несколько тиков (версия `building`, прогресс
 * в ней же); пока сборка не закончена, прогон НЕ отмечается
 * проиндексированным — следующий тик продолжит ту же версию. В начале
 * тика — уборка зависших сборок (сайт выключили посреди сборки).
 *
 * Снимок, а не «страницы прогона»: индексация читает ВСЕ страницы сайта
 * из site_pages (их пишет только обход). Так горячий прогон (5 страниц)
 * и полный (500) обрабатываются одинаково, а страница, которую прогон не
 * трогал, остаётся как была.
 */
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SitesDb } from '../../prisma/sites-db.service';
import type { BuildDeadline } from '../assist-knowledge-core/indexer';
import { qualified } from '../assist-knowledge-core/tables';
import { SiteKnowledgeService } from './site-knowledge.service';
import { SITE_TABLES } from './site-tables';
import { PUBLIC_SITE_HOST } from '../site-core/ownership/host-roles';

export interface IndexTickResult {
  sitesTouched: number;
  versionsCreated: number;
  versionsHeld: number;
  chunksEmbedded: number;
  chunksReused: number;
  budgetExhausted: boolean;
  /** Сборок, приостановленных дедлайном (продолжит следующий тик). */
  buildsPaused?: number;
  /** Снятых зависших сборок (уборка). */
  buildsReaped?: number;
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

  /**
   * Сайты с непроиндексированным последним завершённым прогоном — и сайты,
   * у которых в знаниях живы страницы обхода с хоста «Админки» (Р-З9-24).
   */
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
          -- Р-З9-24: хост отдали «Админке» ПОСЛЕ индексации — живые
          -- документы обхода на нём снимаются переиндексацией последнего
          -- прогона, без нового обхода (его может и не быть: подтверждён
          -- только хост «Админки»). После неё документы — excluded.
          OR EXISTS (
            SELECT 1 FROM ${qualified(SITE_TABLES.documents)} d
              JOIN ${qualified(SITE_TABLES.sources)} s
                ON s."id" = d."sourceId" AND s."kind" = 'crawl'
              JOIN ${qualified('site_hosts')} h
                ON h."siteId" = d."siteId" AND h."accountId" = d."accountId"
             WHERE d."siteId" = x."siteId" AND d."accountId" = x."accountId"
               AND d."status" = 'active' AND h."assistRole" <> $2
               AND substring(d."url" from '^https://([^/:?#]+)') = h."host")
       ORDER BY x."finishedAt" ASC NULLS FIRST
       LIMIT $1`,
      limit,
      PUBLIC_SITE_HOST.assistRole,
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

  async indexSite(c: Candidate, deadline?: BuildDeadline) {
    const ctx = { accountId: c.accountId, siteId: c.siteId };
    const db = this.sitesDb.forAccount(c.accountId);
    const sourceId = await this.crawlSourceId(c.accountId, c.siteId);
    const [rows, adminHosts] = await Promise.all([
      db.sitePage.findMany({
        where: { siteId: c.siteId },
        select: {
          id: true,
          hostId: true,
          url: true,
          finalUrl: true,
          status: true,
          skipReason: true,
          title: true,
          lang: true,
          blocks: true,
          contentHash: true,
        },
      }),
      db.siteHost.findMany({
        where: { siteId: c.siteId, NOT: PUBLIC_SITE_HOST },
        select: { id: true },
      }),
    ]);
    // Р-З9-24 (ТЗ §10, К-9): страницы хоста «Админки» в знания «Сайта» не
    // идут — даже записанные раньше (до отметки хоста) или чужим продуктом
    // обхода. Для индексатора они «исключены»: живые документы снимаются как
    // `excluded`, а не как пропавшие (ворота «массово пропало» не трогают).
    const admin = new Set(adminHosts.map((h) => h.id));
    const pages = rows.map(({ hostId, ...p }) =>
      admin.has(hostId)
        ? {
            ...p,
            status: 'skipped',
            skipReason: 'excluded',
            blocks: null,
            contentHash: null,
          }
        : p,
    );
    const out = await this.knowledge.engine.indexCrawl(
      ctx,
      {
        sourceId,
        crawlRunId: c.runId,
        pages,
        hotUrls: c.hotPages ?? [],
        includeUgc: true,
      },
      deadline,
    );
    // Приостановлена — прогон не отмечен: следующий тик продолжит сборку.
    if (out.busy || out.paused) return out;
    // Продолженная сборка могла начаться с более раннего прогона: отмечаем
    // ЕГО — более новый прогон соберётся следующим тиком (разницей).
    await db.assistSite.updateMany({
      where: { siteId: c.siteId },
      data: { lastIndexedCrawlRunId: out.crawlRunId ?? c.runId },
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
      buildsPaused: 0,
      buildsReaped: 0,
    };
    try {
      res.buildsReaped = await this.knowledge.engine.reapStaleBuilds();
    } catch (e) {
      this.logger.error(
        `Уборка зависших сборок «Сайта» не удалась: ${(e as Error).message}`,
      );
    }
    for (const c of await this.candidates()) {
      if (Date.now() >= deadline) break;
      try {
        const out = await this.indexSite(c, { deadlineAt: deadline });
        if (out.busy) continue;
        res.sitesTouched++;
        if (out.paused) res.buildsPaused = (res.buildsPaused ?? 0) + 1;
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
