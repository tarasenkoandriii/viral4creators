/**
 * Источники, документы, FAQ «Админки» — K3 (те же формы, что у «Сайта»,
 * свои таблицы). Режим задаётся маршрутом и неизменяем; «переместить в
 * Сайт» нет ни в API, ни в UI (§3.4, слой 5).
 *
 * Общий код — `ModeKnowledgeCore` с адаптером ЭТОГО режима: делегаты
 * только assist_admin_* — других у него нет, и имён таблиц «Сайта» в
 * модуле быть не может (правило графа admin-names↛site). Копия публичного
 * обхода (`public_copy`) управляется переключателем настроек (K2), её
 * нельзя удалить или отредактировать как источник.
 */
import { Injectable } from '@nestjs/common';
import { SitesDb } from '../../prisma/sites-db.service';
import type {
  AdminKnowledgeSettings,
  KnowledgeSummary,
} from '../assist-knowledge-core/api-types';
import { KnowledgeBlobStorage } from '../assist-knowledge-core/documents/blob-storage';
import {
  ModeAdapter,
  ModeKnowledgeCore,
} from '../assist-knowledge-core/documents/mode-knowledge.core';
import type {
  ChunkRow,
  DocumentRow,
  ExclusionRow,
  FaqRow,
  ModeRows,
  RowDelegate,
  SourceRow,
  VersionRow,
} from '../assist-knowledge-core/documents/rows';
import type { KnowledgeCtx } from '../assist-knowledge-core/types';
import { LearningBudget } from '../site-ai/learning-budget';
import type { AccountMembership } from '../site-core/account/roles';
import { HostAccessService } from '../site-core/ownership/host-access.service';
import { SiteCrawlService } from '../site-crawl/crawl.service';
import { PublicPageFetcher } from '../site-crawl/page-fetcher';
import { AdminKnowledgeService } from './admin-knowledge.service';

export function adminModeAdapter(
  db: SitesDb,
  api: AdminKnowledgeService,
): ModeAdapter {
  return {
    mode: 'admin',
    api,
    urlPurpose: 'assist-admin',
    // «Увидят все посетители» — не про «Админку»: её знания видят сотрудники.
    requirePublicConfirm: false,
    fileCreateExtra: () => ({}),
    rows(accountId: string): ModeRows {
      const t = db.forAccount(accountId);
      return {
        source: t.assistAdminSource as unknown as RowDelegate<SourceRow>,
        document: t.assistAdminDocument as unknown as RowDelegate<DocumentRow>,
        chunk: t.assistAdminChunk as unknown as RowDelegate<ChunkRow>,
        version:
          t.assistAdminKnowledgeVersion as unknown as RowDelegate<VersionRow>,
        faq: t.assistAdminFaq as unknown as RowDelegate<FaqRow>,
        exclusion:
          t.assistAdminExclusion as unknown as RowDelegate<ExclusionRow>,
      };
    },
    systemSources(): RowDelegate<SourceRow> {
      return db.system(
        'крон разбора документов «Админки»: источники всех кабинетов',
      ).assistAdminSource as unknown as RowDelegate<SourceRow>;
    },
    async publishedVersion(ctx: KnowledgeCtx): Promise<number> {
      const row = await db
        .forAccount(ctx.accountId)
        .assistAdminSettings.findFirst({
          where: { siteId: ctx.siteId },
          select: { knowledgeVersion: true },
        });
      return row?.knowledgeVersion ?? 0;
    },
    async ensureSettings(ctx: KnowledgeCtx): Promise<void> {
      // Строку с умолчаниями §4.17 создаёт K2 при первом обращении.
      await api.getSettings(ctx);
    },
  };
}

@Injectable()
export class AdminSourcesService {
  readonly core: ModeKnowledgeCore;

  constructor(
    db: SitesDb,
    private readonly knowledge: AdminKnowledgeService,
    blob: KnowledgeBlobStorage,
    fetcher: PublicPageFetcher,
    hosts: HostAccessService,
    crawl: SiteCrawlService,
    budget: LearningBudget,
  ) {
    this.core = new ModeKnowledgeCore(adminModeAdapter(db, knowledge), {
      db,
      blob,
      fetcher,
      hosts,
      crawl,
      budget,
    });
  }

  async processPendingFiles(budgetMs: number): Promise<{ processed: number }> {
    return this.core.processPending(budgetMs);
  }

  async getSettings(
    m: AccountMembership,
    siteId: string,
  ): Promise<AdminKnowledgeSettings> {
    await this.core.requireSite(m, siteId);
    return this.knowledge.getSettings({ accountId: m.accountId, siteId });
  }

  /** Переключатель «сотрудникам тоже публичный сайт» / UGC → K2. */
  async updateSettings(
    m: AccountMembership,
    siteId: string,
    patch: Partial<AdminKnowledgeSettings>,
  ): Promise<AdminKnowledgeSettings> {
    await this.core.requireSite(m, siteId);
    const clean: Partial<AdminKnowledgeSettings> = {};
    if (typeof patch.includePublicInAdmin === 'boolean') {
      clean.includePublicInAdmin = patch.includePublicInAdmin;
    }
    if (typeof patch.includeUgcInAdmin === 'boolean') {
      clean.includeUgcInAdmin = patch.includeUgcInAdmin;
    }
    return this.knowledge.updateSettings(
      { accountId: m.accountId, siteId },
      clean,
      m.telegramId,
    );
  }

  async summary(
    m: AccountMembership,
    siteId: string,
  ): Promise<KnowledgeSummary> {
    const settings = await this.getSettings(m, siteId);
    // Вопросы «проверьте ответ» — только из знаний «Сайта» (У-8): здесь пусто.
    return this.core.summary(m, siteId, { suggestedQuestions: [], settings });
  }
}
