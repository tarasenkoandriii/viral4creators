/**
 * Знания режима «Сайт» — K2. Реализует ModeKnowledgeApi поверх
 * нейтрального KnowledgeIndexer с таблицами SITE_TABLES. Единственная
 * точка, через которую песочница (K3) и, в Э2, чат виджета ищут по базе
 * «Сайта». Таблиц «Админки» здесь нет и быть не может (правило графа
 * site-names↛admin).
 *
 * Своё у режима: строка настроек — assist_sites; инвариантный eval в
 * воротах и eval-кейсы сайта (У-6: только «Сайт»); уведомления — владельцу
 * и менеджерам «Сайта».
 */
import { Injectable, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { SitesDb } from '../../prisma/sites-db.service';
import { AnswerEngine } from '../assist-knowledge-core/answer/answer-engine';
import { KnowledgeIndexer } from '../assist-knowledge-core/indexer';
import { qualified } from '../assist-knowledge-core/tables';
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
import { SiteKnowledgeNotifier } from './held-notifier';
import { SITE_TABLES } from './site-tables';

@Injectable()
export class SiteKnowledgeService implements ModeKnowledgeApi {
  readonly engine: KnowledgeIndexer;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sitesDb: SitesDb,
    embedder: GeminiEmbedder,
    usage: AiUsageRecorder,
    budget: LearningBudget,
    private readonly notifier: SiteKnowledgeNotifier,
    @Optional() answer?: AnswerEngine,
  ) {
    this.engine = new KnowledgeIndexer(
      SITE_TABLES,
      { prisma, sitesDb, embedder, usage, budget, answer: answer ?? null },
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
        afterPublish: async (ctx, n) => {
          await this.markStaleEvalCases(ctx, n);
        },
        invariantEval: true,
      },
    );
  }

  /** Строка assist_sites (её создаёт и включение помощника, K3). */
  async ensureSettings(ctx: KnowledgeCtx): Promise<void> {
    const db = this.sitesDb.forAccount(ctx.accountId);
    const row = await db.assistSite.findFirst({
      where: { siteId: ctx.siteId },
      select: { id: true },
    });
    if (row) return;
    try {
      await db.assistSite.create({
        data: { accountId: ctx.accountId, siteId: ctx.siteId },
      });
    } catch (e) {
      // Гонка двух первых вызовов — строка уже есть, это не ошибка.
      if (!(
        e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002'
      )) {
        throw e;
      }
    }
  }

  /**
   * Кейсы eval «по фрагменту» (§4-тер.2): фрагмент-источник ушёл из
   * опубликованной версии (сменилась цена) — кейс `stale`, а не провал.
   */
  async markStaleEvalCases(ctx: KnowledgeCtx, number: number): Promise<number> {
    return this.prisma.$executeRawUnsafe(
      `UPDATE ${qualified('assist_site_eval_cases')} e
          SET "status" = 'stale', "updatedAt" = now()
        WHERE e."siteId" = $1 AND e."accountId" = $2 AND e."status" = 'active'
          AND e."sourceChunkHash" IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM ${qualified(SITE_TABLES.chunks)} c
             WHERE c."siteId" = $1 AND c."contentHash" = e."sourceChunkHash"
               AND $3 = ANY(c."versions") AND NOT c."quarantined")`,
      ctx.siteId,
      ctx.accountId,
      number,
    );
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
