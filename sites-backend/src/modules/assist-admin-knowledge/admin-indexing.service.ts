/**
 * Конвейер индексации «Админки» — K2 (крон assist-admin-embed-run):
 * копия публичного обхода (Р-19, источник kind=public_copy) — те же
 * site_pages, СВОЯ резка и СВОИ эмбеддинги в assist_admin_*; только при
 * includePublicInAdmin; блоки ugc — только при includeUgcInAdmin
 * (умолчание — нет, §3.4). Документы/FAQ «Админки» индексируются сразу
 * маршрутами (K3 → AdminKnowledgeService). Направление только
 * «публичное → Админка»: в «Сайт» отсюда пути нет.
 */
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SitesDb } from '../../prisma/sites-db.service';
import type { BuildDeadline } from '../assist-knowledge-core/indexer';
import { qualified } from '../assist-knowledge-core/tables';
import {
  AdminKnowledgeService,
  PUBLIC_COPY_KIND,
} from './admin-knowledge.service';
import { ADMIN_TABLES } from './admin-tables';

export interface AdminIndexTickResult {
  sitesTouched: number;
  versionsCreated: number;
  budgetExhausted: boolean;
}

const SITES_PER_TICK = 20;

interface Candidate {
  runId: string;
  siteId: string;
  accountId: string;
  includePublicInAdmin: boolean | null;
  includeUgcInAdmin: boolean | null;
}

@Injectable()
export class AdminIndexingService {
  private readonly logger = new Logger(AdminIndexingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sitesDb: SitesDb,
    private readonly knowledge: AdminKnowledgeService,
  ) {}

  /**
   * Сайты с включённым помощником, у которых последний завершённый прогон
   * ещё не скопирован в «Админку». Строки настроек «Админки» может ещё не
   * быть — тогда умолчания (копия включена).
   */
  async candidates(limit = SITES_PER_TICK): Promise<Candidate[]> {
    return this.prisma.$queryRawUnsafe<Candidate[]>(
      `SELECT * FROM (
         SELECT DISTINCT ON (r."siteId")
                r."id" AS "runId", r."siteId", r."accountId",
                s."includePublicInAdmin", s."includeUgcInAdmin",
                s."lastIndexedCrawlRunId", r."finishedAt"
           FROM ${qualified('site_crawl_runs')} r
           JOIN ${qualified('assist_sites')} a
             ON a."siteId" = r."siteId" AND a."accountId" = r."accountId"
           LEFT JOIN ${qualified(ADMIN_TABLES.settings)} s
             ON s."siteId" = r."siteId" AND s."accountId" = r."accountId"
          WHERE r."product" = 'assist' AND r."status" = 'done' AND a."enabled"
          ORDER BY r."siteId", r."finishedAt" DESC NULLS LAST, r."createdAt" DESC
       ) x
       WHERE x."lastIndexedCrawlRunId" IS DISTINCT FROM x."runId"
       ORDER BY x."finishedAt" ASC NULLS FIRST
       LIMIT $1`,
      limit,
    );
  }

  private async sourceId(accountId: string, siteId: string): Promise<string> {
    const db = this.sitesDb.forAccount(accountId);
    const found = await db.assistAdminSource.findFirst({
      where: { siteId, kind: PUBLIC_COPY_KIND },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
    if (found) return found.id;
    const created = await db.assistAdminSource.create({
      data: {
        accountId,
        siteId,
        kind: PUBLIC_COPY_KIND,
        title: 'Публичный сайт',
        status: 'active',
      },
      select: { id: true },
    });
    return created.id;
  }

  async indexSite(c: Candidate, deadline?: BuildDeadline) {
    const ctx = { accountId: c.accountId, siteId: c.siteId };
    const db = this.sitesDb.forAccount(c.accountId);
    await this.knowledge.ensureSettings(ctx);
    const settings = await this.knowledge.getSettings(ctx);
    if (!settings.includePublicInAdmin) {
      // Копия выключена: документы уже убраны updateSettings; прогон
      // отмечаем, чтобы не крутить его каждый тик.
      await db.assistAdminSettings.updateMany({
        where: { siteId: c.siteId },
        data: { lastIndexedCrawlRunId: c.runId },
      });
      return null;
    }
    const sourceId = await this.sourceId(c.accountId, c.siteId);
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
    const out = await this.knowledge.engine.indexCrawl(
      ctx,
      {
        sourceId,
        crawlRunId: c.runId,
        pages,
        // «Горячие страницы» — свойство публичного виджета; копия обновляется
        // вместе с обходом, бюджет при исчерпании ей не положен.
        hotUrls: [],
        includeUgc: settings.includeUgcInAdmin,
      },
      deadline,
    );
    // Э2: сборка с дедлайном тика — приостановленная не отмечает прогон.
    if (out.busy || out.paused) return out;
    await db.assistAdminSettings.updateMany({
      where: { siteId: c.siteId },
      data: { lastIndexedCrawlRunId: out.crawlRunId ?? c.runId },
    });
    const documentsCount = await db.assistAdminDocument.count({
      where: { sourceId, status: 'active' },
    });
    await db.assistAdminSource.updateMany({
      where: { id: sourceId },
      data: { documentsCount, lastSyncAt: new Date() },
    });
    return out;
  }

  async tick(budgetMs: number): Promise<AdminIndexTickResult> {
    const deadline = Date.now() + budgetMs;
    const res: AdminIndexTickResult = {
      sitesTouched: 0,
      versionsCreated: 0,
      budgetExhausted: false,
    };
    try {
      await this.knowledge.engine.reapStaleBuilds();
    } catch (e) {
      this.logger.error(
        `Уборка зависших сборок «Админки» не удалась: ${(e as Error).message}`,
      );
    }
    for (const c of await this.candidates()) {
      if (Date.now() >= deadline) break;
      try {
        const out = await this.indexSite(c, { deadlineAt: deadline });
        if (out?.busy) continue;
        res.sitesTouched++;
        if (out?.version) res.versionsCreated++;
        res.budgetExhausted ||= !!out?.budgetExhausted;
      } catch (e) {
        this.logger.error(
          `Копия обхода в «Админку» для сайта ${c.siteId} не удалась: ${(e as Error).message}`,
        );
      }
    }
    return res;
  }
}
