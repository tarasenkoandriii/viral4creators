/**
 * Знания режима «Админка» — K2. Реализует ModeKnowledgeApi поверх
 * нейтрального KnowledgeIndexer с ADMIN_TABLES: своя индексация, свои
 * эмбеддинги (У-3: никаких общих кэшей векторов с «Сайтом» — копия вектора
 * по contentHash ищется только в assist_admin_chunks), свои версии.
 * Инвариантного eval нет (У-6: eval-кейсы — только «Сайт»).
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { SitesDb } from '../../prisma/sites-db.service';
import type { AdminKnowledgeSettings } from '../assist-knowledge-core/api-types';
import { KnowledgeIndexer } from '../assist-knowledge-core/indexer';
import type {
  DocumentInput,
  ExclusionInput,
  KnowledgeCtx,
  ModeKnowledgeApi,
  SearchHit,
  SearchQuery,
  VersionResult,
  VersionTrigger,
} from '../assist-knowledge-core/types';
import { GeminiEmbedder } from '../site-ai/embedder';
import { LearningBudget } from '../site-ai/learning-budget';
import { AiUsageRecorder } from '../site-ai/usage-recorder';
import { AdminKnowledgeNotifier } from './admin-notifier';
import { ADMIN_TABLES } from './admin-tables';

/** Источник копии публичного обхода (Р-19) — один на сайт. */
export const PUBLIC_COPY_KIND = 'public_copy';

@Injectable()
export class AdminKnowledgeService implements ModeKnowledgeApi {
  readonly engine: KnowledgeIndexer;
  /**
   * Свой, не провайдер модуля: модуль «Админки» собирает координатор, а
   * уведомителю нужен только SitesDb. Тесты подменяют notifier.fetchImpl.
   */
  readonly notifier: AdminKnowledgeNotifier;

  constructor(
    prisma: PrismaService,
    private readonly sitesDb: SitesDb,
    embedder: GeminiEmbedder,
    usage: AiUsageRecorder,
    budget: LearningBudget,
  ) {
    this.notifier = new AdminKnowledgeNotifier(sitesDb);
    this.engine = new KnowledgeIndexer(
      ADMIN_TABLES,
      { prisma, sitesDb, embedder, usage, budget, answer: null },
      {
        ensureSettings: (ctx) => this.ensureSettings(ctx),
        onHeld: (ctx, p) =>
          this.notifier.versionHeld({
            ...ctx,
            number: p.number,
            reason: p.reason,
          }),
        onQuarantine: (ctx, p) =>
          this.notifier.quarantineAlarm({ ...ctx, ...p }),
        invariantEval: false,
      },
    );
  }

  /** Строка настроек с умолчаниями §4.17 (копия публичного — да, UGC — нет). */
  async ensureSettings(ctx: KnowledgeCtx): Promise<void> {
    await this.sitesDb
      .forAccount(ctx.accountId)
      .assistAdminSettings.createMany({
        data: [{ accountId: ctx.accountId, siteId: ctx.siteId }],
        skipDuplicates: true,
      });
  }

  /** Строка настроек (создаётся с умолчаниями §4.17 при первом обращении). */
  async getSettings(ctx: KnowledgeCtx): Promise<AdminKnowledgeSettings> {
    await this.ensureSettings(ctx);
    const row = await this.sitesDb
      .forAccount(ctx.accountId)
      .assistAdminSettings.findFirstOrThrow({
        where: { siteId: ctx.siteId },
        select: { includePublicInAdmin: true, includeUgcInAdmin: true },
      });
    return row;
  }

  private async publicCopySource(ctx: KnowledgeCtx): Promise<string | null> {
    const row = await this.sitesDb
      .forAccount(ctx.accountId)
      .assistAdminSource.findFirst({
        where: { siteId: ctx.siteId, kind: PUBLIC_COPY_KIND },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
      });
    return row?.id ?? null;
  }

  /**
   * Переключатель «сотрудникам тоже публичный сайт» / UGC. Выключили копию —
   * документы public_copy уходят из базы «Админки» новой версией сразу;
   * включили (или сменили UGC) — копия строится следующим тиком индексации
   * (lastIndexedCrawlRunId сбрасывается).
   */
  async updateSettings(
    ctx: KnowledgeCtx,
    patch: Partial<AdminKnowledgeSettings>,
    byTelegramId: bigint,
  ): Promise<AdminKnowledgeSettings> {
    const before = await this.getSettings(ctx);
    const data: Prisma.AssistAdminSettingsUpdateManyMutationInput = {};
    if (typeof patch.includePublicInAdmin === 'boolean') {
      data.includePublicInAdmin = patch.includePublicInAdmin;
    }
    if (typeof patch.includeUgcInAdmin === 'boolean') {
      data.includeUgcInAdmin = patch.includeUgcInAdmin;
    }
    const after = { ...before, ...data } as AdminKnowledgeSettings;
    const changed =
      after.includePublicInAdmin !== before.includePublicInAdmin ||
      after.includeUgcInAdmin !== before.includeUgcInAdmin;
    if (!changed) return before;
    await this.sitesDb
      .forAccount(ctx.accountId)
      .assistAdminSettings.updateMany({
        where: { siteId: ctx.siteId },
        data: { ...data, lastIndexedCrawlRunId: null },
      });
    if (before.includePublicInAdmin && !after.includePublicInAdmin) {
      const sourceId = await this.publicCopySource(ctx);
      if (sourceId) {
        await this.engine.removeDocuments(ctx, sourceId, 'all', byTelegramId);
      }
    }
    return after;
  }

  indexDocuments(
    ctx: KnowledgeCtx,
    sourceId: string,
    docs: DocumentInput[],
    opts: {
      trigger: VersionTrigger;
      byTelegramId?: bigint | null;
      replaceAll?: boolean;
    },
  ): Promise<VersionResult> {
    return this.engine.indexDocuments(ctx, sourceId, docs, opts);
  }

  removeDocuments(
    ctx: KnowledgeCtx,
    sourceId: string,
    refs: string[] | 'all',
    byTelegramId: bigint | null,
  ): Promise<VersionResult> {
    return this.engine.removeDocuments(ctx, sourceId, refs, byTelegramId);
  }

  applyExclusion(
    ctx: KnowledgeCtx,
    exclusion: ExclusionInput,
    byTelegramId: bigint,
  ): Promise<{ chunksDeleted: number; version: VersionResult }> {
    return this.engine.applyExclusion(ctx, exclusion, byTelegramId);
  }

  liftExclusion(ctx: KnowledgeCtx, exclusionId: string): Promise<void> {
    return this.engine.liftExclusion(ctx, exclusionId);
  }

  allowQuarantined(
    ctx: KnowledgeCtx,
    chunkId: string,
    byTelegramId: bigint,
  ): Promise<VersionResult> {
    return this.engine.allowQuarantined(ctx, chunkId, byTelegramId);
  }

  publishHeld(
    ctx: KnowledgeCtx,
    number: number,
    byTelegramId: bigint,
  ): Promise<VersionResult> {
    return this.engine.publishHeld(ctx, number, byTelegramId);
  }

  discard(
    ctx: KnowledgeCtx,
    number: number,
    byTelegramId: bigint,
  ): Promise<VersionResult> {
    return this.engine.discard(ctx, number, byTelegramId);
  }

  rollback(
    ctx: KnowledgeCtx,
    toNumber: number,
    byTelegramId: bigint,
  ): Promise<VersionResult> {
    return this.engine.rollback(ctx, toNumber, byTelegramId);
  }

  search(q: SearchQuery): Promise<SearchHit[]> {
    return this.engine.search(q);
  }
}
