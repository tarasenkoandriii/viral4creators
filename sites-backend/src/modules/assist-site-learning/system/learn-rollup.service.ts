/**
 * Суточный разбор обучения — L (крон assist-learn-rollup, §4.15, §4-тер.14):
 *  1. досчитать недостающие векторы элементов (бюджет обучения) и
 *     кластеризовать новые (clustering.ts), обновить size/distinctVisitors;
 *  2. переоткрыть решённые кластеры с новым unknown через ≥ 14 дней;
 *  3. проверенные ответы: reviewAt истёк → needs_review; источник
 *     (sourceRefs) изменился в новой версии или свежий фрагмент с другим
 *     числом → needs_review + conflictNote «на сайте теперь: …» (§4-тер.15 п.11);
 *  4. плановый eval по расписанию (до Э4 — раз в месяц; бюджет исчерпан —
 *     отложить с уведомлением в бот через notify.ts);
 *  5. processForgetJobs (также зовёт assist-handoff-tick — минутная задержка).
 * Основная роль; все сайты; каждый шаг — по сайту, сбой сайта не роняет крон.
 *
 * Уточнения реализации (L):
 *  - `scope` (тесты на общей базе) ограничивает ВСЕ запросы прохода: список
 *    сайтов и задания forget; дальше каждый запрос — по siteId/accountId;
 *  - источник проверенного ответа «изменился»: фрагмента с хешем из
 *    sourceRefs нет в опубликованной версии; источник без хеша (черновик
 *    мастера Э2 — только URL) сверяется по числам: число ответа, которого
 *    нет во фрагментах страницы, где числа есть, — конфликт; после сверки
 *    хеш «закрепляется» (иначе тот же конфликт приходил бы каждую ночь);
 *  - хвост forget не трогает задание, пока диалоги ещё не удалены (W зовёт
 *    enqueue ДО удаления) — кроме заданий старше FORGET_SETTLE_MS; после
 *    вариантов — кластеры сайта: размер и посетители пересчитываются, пустой
 *    кластер удаляется, подпись из удалённого вопроса заменяется;
 *  - зависимости, кроме PrismaService, необязательны: H зовёт
 *    `processForgetJobs` из своего крона (в приложении DI даёт всё).
 */
import { Injectable, Logger, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  KNOWLEDGE_DEFAULTS,
  LEARNING_DEFAULTS,
} from '../../../config/assist-defaults';
import { PrismaService } from '../../../prisma/prisma.service';
import { SitesDb } from '../../../prisma/sites-db.service';
import { estimateCost } from '../../../shared/ai-pricing';
import type { CronScope } from '../../../common/cron-scope';
import {
  GeminiEmbedder,
  estimateEmbedTokens,
  toVectorLiteral,
} from '../../site-ai/embedder';
import { LearningBudget } from '../../site-ai/learning-budget';
import { AiUsageRecorder } from '../../site-ai/usage-recorder';
import { clusterItems, cosine } from '../clustering';
import {
  GoldenAnswersService,
  closestChunk,
  parseSourceRefs,
  parseVariantRefs,
  type SourceRef,
} from '../golden.service';
import { numbersOf } from '../learning-common';
import { LearningQualityService } from '../quality.service';

export interface LearnRollupResult {
  sites: number;
  clustered: number;
  reopened: number;
  needsReview: number;
  conflicts: number;
  evalRuns: number;
  evalDeferred: number;
  forgetJobs: number;
}

/** Элементов без вектора на сайт за прогон (бюджет обучения). */
export const EMBED_ITEMS_PER_SITE = 200;
/** Элементов в кластеризации сайта (самые свежие; ретенция — 90 дней). */
export const CLUSTER_ITEMS_PER_SITE = 5000;
/** Задание forget, чьи диалоги ещё живы, ждёт удаления не дольше. */
export const FORGET_SETTLE_MS = 10 * 60 * 1000;
/** «На сайте теперь: …» — длина выдержки. */
export const CONFLICT_SNIPPET = 200;

const T = {
  items: '"sites"."assist_site_learning_items"',
  clusters: '"sites"."assist_site_learning_clusters"',
  faq: '"sites"."assist_site_faq"',
};

interface SiteRef {
  accountId: string;
  siteId: string;
  enabled: boolean;
  knowledgeVersion: number;
}

interface ItemVec {
  id: string;
  kind: string;
  visitorId: string | null;
  suspicious: boolean;
  lang: string | null;
  createdAt: Date;
  clusterId: string | null;
  questionMasked: string;
  embedding: number[];
}

interface ClusterVec {
  id: string;
  lang: string | null;
  status: string;
  label: string;
  resolvedAt: Date | null;
  firstSeenAt: Date;
  centroid: number[];
}

function parseVector(v: unknown): number[] {
  if (typeof v !== 'string' || !v.startsWith('[')) return [];
  try {
    const a = JSON.parse(v) as unknown;
    return Array.isArray(a) && a.every((x) => typeof x === 'number')
      ? (a as number[])
      : [];
  } catch {
    return [];
  }
}

/** Преобладающий тип сигнала; ничья — по важности (wrong > unknown > unhappy). */
export function dominantKind(kinds: string[]): string {
  const order = ['wrong', 'unknown', 'unhappy'];
  const rank = (k: string) => (order.includes(k) ? order.indexOf(k) : 99);
  const n = new Map<string, number>();
  for (const k of kinds) n.set(k, (n.get(k) ?? 0) + 1);
  return [...n.entries()].sort(
    (a, b) => b[1] - a[1] || rank(a[0]) - rank(b[0]),
  )[0][0];
}

/** Подпись кластера — вопрос участника, ближайший к центроиду (ничья — ранний). */
export function typicalQuestion(
  members: Array<Pick<ItemVec, 'questionMasked' | 'embedding' | 'createdAt'>>,
  centroid: number[],
): string {
  let best = members[0];
  let bestSim = -Infinity;
  for (const m of members) {
    const s = cosine(m.embedding, centroid);
    if (s > bestSim + 1e-12) {
      best = m;
      bestSim = s;
    }
  }
  return best.questionMasked;
}

/** Выдержка фрагмента вокруг первого «чужого» числа (или начало). */
export function conflictSnippet(
  chunk: string,
  answerNumbers: string[],
): string {
  const text = chunk.replace(/\s+/g, ' ').trim();
  if (Array.from(text).length <= CONFLICT_SNIPPET) return text;
  const own = new Set(answerNumbers);
  let at = 0;
  for (const m of text.matchAll(/\d+(?:[.,]\d+)?/g)) {
    if (!own.has(m[0].replace(',', '.').replace(/^0+(?=\d)/, ''))) {
      at = m.index ?? 0;
      break;
    }
  }
  const start = Math.max(0, at - CONFLICT_SNIPPET / 2);
  const cut = text.slice(start, start + CONFLICT_SNIPPET).trim();
  return `${start > 0 ? '…' : ''}${cut}${start + CONFLICT_SNIPPET < text.length ? '…' : ''}`;
}

@Injectable()
export class LearnRollup {
  now: () => Date = () => new Date();
  private readonly logger = new Logger(LearnRollup.name);
  private readonly sitesDb: SitesDb;

  constructor(
    readonly prisma: PrismaService,
    @Optional() private readonly golden?: GoldenAnswersService,
    @Optional() private readonly quality?: LearningQualityService,
    @Optional() private readonly embedder?: GeminiEmbedder,
    @Optional() private readonly usage?: AiUsageRecorder,
    @Optional() private readonly budget?: LearningBudget,
  ) {
    this.sitesDb = new SitesDb(prisma);
  }

  /** `scope` — только тесты на общей базе (контракт Э3 §9 п.6). */
  async run(now: Date, scope?: CronScope): Promise<LearnRollupResult> {
    const out: LearnRollupResult = {
      sites: 0,
      clustered: 0,
      reopened: 0,
      needsReview: 0,
      conflicts: 0,
      evalRuns: 0,
      evalDeferred: 0,
      forgetJobs: 0,
    };
    const sites = (await this.prisma.assistSite.findMany({
      where: scope ? { siteId: { in: scope.siteIds } } : {},
      select: {
        accountId: true,
        siteId: true,
        enabled: true,
        knowledgeVersion: true,
      },
      orderBy: { siteId: 'asc' },
    })) as SiteRef[];
    for (const s of sites) {
      out.sites++;
      try {
        await this.embedMissing(s);
        const c = await this.clusterSite(s, now);
        out.clustered += c.clustered;
        out.reopened += c.reopened;
        // Ретенция и forget удаляют элементы каскадом — размер, посетители и
        // подпись кластеров не должны держаться за удалённые вопросы.
        await this.refreshClusters(s);
        const g = await this.reviewGolden(s, now);
        out.needsReview += g.needsReview;
        out.conflicts += g.conflicts;
        const e = await this.scheduledEval(s, now);
        if (e === 'done') out.evalRuns++;
        if (e === 'deferred') out.evalDeferred++;
      } catch (e) {
        this.logger.error(
          `разбор обучения сайта ${s.siteId} не удался: ${(e as Error | null)?.name ?? 'Error'}`,
        );
      }
    }
    out.forgetJobs = await this.processForgetJobs(
      LEARNING_DEFAULTS.forgetJobsPerTick,
      scope,
    );
    return out;
  }

  // ── 1. векторы ──────────────────────────────────────────────────────

  private async embedMissing(s: SiteRef): Promise<number> {
    if (!this.embedder || !this.budget || !this.usage) return 0;
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{ id: string; questionMasked: string }>
    >(
      `SELECT "id", "questionMasked" FROM ${T.items}
        WHERE "siteId" = $1 AND "accountId" = $2 AND "questionEmbedding" IS NULL
          AND "kind" <> 'operator_fix' AND "clusterId" IS NULL
        ORDER BY "createdAt", "id" LIMIT ${EMBED_ITEMS_PER_SITE}`,
      s.siteId,
      s.accountId,
    );
    if (!rows.length) return 0;
    const tokens = rows.reduce(
      (n, r) => n + estimateEmbedTokens(r.questionMasked),
      0,
    );
    const est = estimateCost(KNOWLEDGE_DEFAULTS.embedModel, {
      inputTokens: tokens,
    }).costMicroUsd;
    // Исчерпан — элементы подождут следующего периода (без вектора они не
    // кластеризуются, но и не теряются).
    if (!(await this.budget.reserve(s.accountId, s.siteId, est))) return 0;
    let spent = 0;
    try {
      const r = await this.embedder.embed(
        rows.map((x) => x.questionMasked),
        'query',
      );
      const u = await this.usage.record(this.sitesDb.forAccount(s.accountId), {
        accountId: s.accountId,
        siteId: s.siteId,
        operation: 'assist-embed',
        model: r.model,
        units: { inputTokens: r.inputTokens },
      });
      spent = u.costMicroUsd;
      for (let i = 0; i < rows.length; i++) {
        await this.prisma.$executeRawUnsafe(
          `UPDATE ${T.items} SET "questionEmbedding" = $3::"extensions"."vector", "updatedAt" = now()
            WHERE "id" = $1 AND "siteId" = $2 AND "questionEmbedding" IS NULL`,
          rows[i].id,
          s.siteId,
          toVectorLiteral(r.vectors[i]),
        );
      }
      return rows.length;
    } catch (e) {
      this.logger.warn(
        `векторы очереди не получены (site ${s.siteId}): ${(e as Error | null)?.name ?? 'Error'}`,
      );
      return 0;
    } finally {
      await this.budget
        .adjust(s.accountId, s.siteId, spent - est)
        .catch(() => undefined);
    }
  }

  // ── 2. кластеры и переоткрытие ──────────────────────────────────────

  private async loadItems(s: SiteRef): Promise<ItemVec[]> {
    const rows = await this.prisma.$queryRawUnsafe<
      Array<Omit<ItemVec, 'embedding'> & { emb: string }>
    >(
      `SELECT "id", "kind", "visitorId", "suspicious", "lang", "createdAt", "clusterId",
              "questionMasked", "questionEmbedding"::text AS emb
         FROM ${T.items}
        WHERE "siteId" = $1 AND "accountId" = $2 AND "kind" <> 'operator_fix'
          AND "questionEmbedding" IS NOT NULL
        ORDER BY "createdAt" DESC, "id" LIMIT ${CLUSTER_ITEMS_PER_SITE}`,
      s.siteId,
      s.accountId,
    );
    return rows.map(({ emb, ...r }) => ({ ...r, embedding: parseVector(emb) }));
  }

  private async loadClusters(s: SiteRef): Promise<ClusterVec[]> {
    const rows = await this.prisma.$queryRawUnsafe<
      Array<Omit<ClusterVec, 'centroid'> & { c: string | null }>
    >(
      `SELECT "id", "lang", "status", "label", "resolvedAt", "firstSeenAt", "centroid"::text AS c
         FROM ${T.clusters}
        WHERE "siteId" = $1 AND "accountId" = $2
        ORDER BY "createdAt", "id"`,
      s.siteId,
      s.accountId,
    );
    return rows.map(({ c, ...r }) => ({ ...r, centroid: parseVector(c) }));
  }

  private async clusterSite(
    s: SiteRef,
    now: Date,
  ): Promise<{ clustered: number; reopened: number }> {
    const items = await this.loadItems(s);
    if (!items.length) return { clustered: 0, reopened: 0 };
    const clusters = await this.loadClusters(s);
    const known = new Map(clusters.map((c) => [c.id, c] as const));
    const assignments = clusterItems(
      items,
      clusters.map((c) => ({ id: c.id, centroid: c.centroid, lang: c.lang })),
      LEARNING_DEFAULTS.clusterSimilarity,
    );
    const byId = new Map(items.map((i) => [i.id, i] as const));
    let clustered = 0;
    let reopened = 0;
    for (const a of assignments) {
      const members = a.itemIds.map((id) => byId.get(id) as ItemVec);
      const added = members.filter((m) => m.clusterId !== a.clusterKey);
      const times = members.map((m) => m.createdAt.getTime());
      const lastSeenAt = new Date(Math.max(...times));
      const firstSeen = new Date(Math.min(...times));
      const centroid = toVectorLiteral(a.centroid);
      const kind = dominantKind(members.map((m) => m.kind));
      const existing = known.get(a.clusterKey);
      let clusterId: string;
      if (!existing) {
        const label = typicalQuestion(members, a.centroid);
        const rows = await this.prisma.$queryRawUnsafe<Array<{ id: string }>>(
          `INSERT INTO ${T.clusters}
             ("id", "accountId", "siteId", "label", "kind", "size", "distinctVisitors",
              "centroid", "lang", "firstSeenAt", "lastSeenAt", "status", "createdAt", "updatedAt")
           VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6,
                   $7::"extensions"."vector", $8, $9, $10, 'open', now(), now())
           RETURNING "id"`,
          s.accountId,
          s.siteId,
          label,
          kind,
          members.length,
          a.distinctVisitors,
          centroid,
          members[0].lang,
          firstSeen,
          lastSeenAt,
        );
        clusterId = rows[0].id;
      } else {
        clusterId = existing.id;
        const labelGone = !members.some(
          (m) => m.questionMasked === existing.label,
        );
        // §4-тер.3 п.4: решённый кластер, по которому через ≥ 14 дней снова
        // «не знал», — снова в очереди (метрика «повторный пробел»).
        const reopen =
          existing.status === 'resolved' &&
          existing.resolvedAt !== null &&
          added.some(
            (m) =>
              m.kind === 'unknown' &&
              m.createdAt.getTime() - (existing.resolvedAt as Date).getTime() >=
                LEARNING_DEFAULTS.reopenAfterMs,
          );
        if (reopen) reopened++;
        await this.prisma.$executeRawUnsafe(
          `UPDATE ${T.clusters}
              SET "size" = $3, "distinctVisitors" = $4, "centroid" = $5::"extensions"."vector",
                  "lastSeenAt" = GREATEST("lastSeenAt", $6), "firstSeenAt" = LEAST("firstSeenAt", $7),
                  "kind" = CASE WHEN "status" = 'open' THEN $8 ELSE "kind" END,
                  "label" = CASE WHEN $9 THEN $10 ELSE "label" END,
                  "status" = CASE WHEN $11 THEN 'open' ELSE "status" END,
                  "reopenedAt" = CASE WHEN $11 THEN $12 ELSE "reopenedAt" END,
                  "updatedAt" = now()
            WHERE "id" = $1 AND "siteId" = $2`,
          clusterId,
          s.siteId,
          members.length,
          a.distinctVisitors,
          centroid,
          lastSeenAt,
          firstSeen,
          kind,
          labelGone,
          typicalQuestion(members, a.centroid),
          reopen,
          now,
        );
      }
      if (added.length) {
        clustered += added.length;
        await this.prisma.assistSiteLearningItem.updateMany({
          where: {
            siteId: s.siteId,
            accountId: s.accountId,
            id: { in: added.map((m) => m.id) },
          },
          data: { clusterId },
        });
      }
    }
    return { clustered, reopened };
  }

  // ── 3. проверенные ответы: срок пересмотра и конфликты ──────────────

  private async reviewGolden(
    s: SiteRef,
    now: Date,
  ): Promise<{ needsReview: number; conflicts: number }> {
    const t = this.sitesDb.forAccount(s.accountId);
    const expired = await t.assistSiteFaq.updateMany({
      where: { siteId: s.siteId, status: 'active', reviewAt: { lte: now } },
      data: { status: 'needs_review' },
    });
    const out = s.knowledgeVersion
      ? await this.checkConflicts(s, expired.count)
      : { needsReview: expired.count, conflicts: 0 };
    if (out.needsReview > 0) {
      // Прямой путь выключен без новой версии — кэш ответов (ключ — версия)
      // отдавал бы прежний ответ из проверенного ещё сутки.
      await this.prisma.assistSiteSemanticCache.deleteMany({
        where: { siteId: s.siteId },
      });
    }
    return out;
  }

  private async checkConflicts(
    s: SiteRef,
    expired: number,
  ): Promise<{ needsReview: number; conflicts: number }> {
    const t = this.sitesDb.forAccount(s.accountId);
    let needsReview = expired;
    let conflicts = 0;
    const rows = await t.assistSiteFaq.findMany({
      where: {
        siteId: s.siteId,
        status: 'active',
        NOT: { sourceRefs: { equals: Prisma.DbNull } },
      },
      select: { id: true, answer: true, sourceRefs: true },
      take: 500,
    });
    for (const g of rows) {
      const refs = parseSourceRefs(g.sourceRefs);
      if (!refs.length) continue;
      const r = await this.checkRefs(s, g.answer, refs);
      if (r.conflict) {
        conflicts++;
        needsReview++;
      }
      if (r.conflict || r.pinned) {
        await t.assistSiteFaq.updateMany({
          where: { id: g.id, siteId: s.siteId, status: 'active' },
          data: {
            ...(r.conflict
              ? { status: 'needs_review', conflictNote: r.conflict }
              : {}),
            ...(r.pinned
              ? { sourceRefs: r.refs as unknown as Prisma.InputJsonValue }
              : {}),
          },
        });
      }
    }
    return { needsReview, conflicts };
  }

  /** Сверка источников ответа с опубликованной версией. */
  private async checkRefs(
    s: SiteRef,
    answer: string,
    refs: SourceRef[],
  ): Promise<{ conflict: string | null; pinned: boolean; refs: SourceRef[] }> {
    const t = this.sitesDb.forAccount(s.accountId);
    const v = s.knowledgeVersion;
    const nums = numbersOf(answer);
    const out: SourceRef[] = [];
    let pinned = false;
    let conflict: string | null = null;
    for (const ref of refs) {
      const page = await t.assistSiteChunk.findMany({
        where: {
          siteId: s.siteId,
          versions: { has: v },
          quarantined: false,
          ugc: false,
          sourceType: { not: 'faq' },
          ...(ref.documentId
            ? { documentId: ref.documentId }
            : ref.url
              ? { url: ref.url }
              : { contentHash: ref.chunkHash ?? '' }),
        },
        select: { contentHash: true, text: true, documentId: true, url: true },
        take: 50,
      });
      if (ref.chunkHash) {
        if (page.some((c) => c.contentHash === ref.chunkHash)) {
          out.push(ref);
          continue;
        }
        if (!conflict) {
          conflict = page.length
            ? `На сайте теперь: «${conflictSnippet(closestChunk(answer, page).text, nums)}»`
            : `Источника больше нет на сайте${ref.url ? `: ${ref.url}` : ''}`;
        }
        out.push(ref);
        continue;
      }
      // Источник без хеша (мастер Э2): сверка чисел, затем закрепление.
      if (!page.length) {
        out.push(ref);
        continue;
      }
      const pageNums = new Set(page.flatMap((c) => numbersOf(c.text)));
      const best = closestChunk(answer, page);
      if (!conflict && nums.length && pageNums.size) {
        const missing = nums.filter((n) => !pageNums.has(n));
        if (missing.length) {
          const withNums =
            page.find((c) =>
              numbersOf(c.text).some((n) => !nums.includes(n)),
            ) ?? best;
          conflict = `На сайте теперь: «${conflictSnippet(withNums.text, nums)}»`;
        }
      }
      out.push({
        documentId: best.documentId,
        url: ref.url ?? best.url,
        chunkHash: best.contentHash,
      });
      pinned = true;
    }
    return { conflict, pinned, refs: out };
  }

  // ── 4. плановый eval ────────────────────────────────────────────────

  private async scheduledEval(
    s: SiteRef,
    now: Date,
  ): Promise<'done' | 'deferred' | null> {
    if (!this.quality || !s.enabled || !s.knowledgeVersion) return null;
    const last = await this.quality.lastScheduledRun(s.accountId, s.siteId);
    if (
      last &&
      now.getTime() - last.getTime() < LEARNING_DEFAULTS.scheduledEvalEveryMs
    ) {
      return null;
    }
    // Отложенный сегодня — не повторять каждый тик (крон раз в сутки, но
    // ручной вызов крона не должен множить строки «отложено»).
    const today = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const deferredToday = await this.prisma.assistSiteEvalRun.count({
      where: {
        siteId: s.siteId,
        accountId: s.accountId,
        kind: 'scheduled',
        model: '',
        createdAt: { gte: today },
      },
    });
    if (deferredToday > 0) return null;
    const r = await this.quality.runEval(null, s.siteId, 'scheduled');
    return r.status;
  }

  // ── 5. хвост forget ─────────────────────────────────────────────────

  /** Хвост forget (§4-тер.12): варианты по variantRefs; processedAt. */
  async processForgetJobs(limit: number, scope?: CronScope): Promise<number> {
    const now = this.now();
    const jobs = await this.prisma.assistSiteForgetJob.findMany({
      where: {
        processedAt: null,
        ...(scope ? { siteId: { in: scope.siteIds } } : {}),
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: Math.max(1, Math.min(500, Math.floor(limit) || 1)),
    });
    let done = 0;
    for (const job of jobs) {
      try {
        const site = await this.prisma.assistSite.findFirst({
          where: { siteId: job.siteId },
          select: { accountId: true },
        });
        if (site) {
          const alive = await this.prisma.assistSiteConversation.count({
            where: {
              siteId: job.siteId,
              accountId: site.accountId,
              id: { in: job.conversationIds },
            },
          });
          if (
            alive > 0 &&
            now.getTime() - job.createdAt.getTime() < FORGET_SETTLE_MS
          ) {
            continue;
          }
          await this.forgetVariants(
            { accountId: site.accountId, siteId: job.siteId },
            job.conversationIds,
          );
          await this.refreshClusters({
            accountId: site.accountId,
            siteId: job.siteId,
          });
        }
        await this.prisma.assistSiteForgetJob.updateMany({
          where: { id: job.id, processedAt: null },
          data: { processedAt: now },
        });
        done++;
      } catch (e) {
        this.logger.warn(
          `хвост forget ${job.id} (site ${job.siteId}) не обработан: ${(e as Error | null)?.name ?? 'Error'}`,
        );
      }
    }
    return done;
  }

  /** Дословные вопросы посетителя — из вариантов проверенных ответов. */
  private async forgetVariants(
    ctx: { accountId: string; siteId: string },
    conversationIds: string[],
  ): Promise<void> {
    if (!conversationIds.length) return;
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{
        id: string;
        variants: string[];
        variantRefs: Prisma.JsonValue;
        status: string;
      }>
    >(
      `SELECT "id", "variants", "variantRefs", "status" FROM ${T.faq}
        WHERE "siteId" = $1 AND "accountId" = $2
          AND jsonb_typeof("variantRefs") = 'array'
          AND EXISTS (
            SELECT 1 FROM jsonb_array_elements("variantRefs") e
             WHERE e->>'conversationId' = ANY($3::text[]))`,
      ctx.siteId,
      ctx.accountId,
      conversationIds,
    );
    const gone = new Set(conversationIds);
    for (const f of rows) {
      const refs = parseVariantRefs(f.variantRefs);
      const keep = refs.filter((r) => !gone.has(r.conversationId));
      const quoted = new Set(
        refs.filter((r) => gone.has(r.conversationId)).map((r) => r.variant),
      );
      // Вариант остаётся, если та же формулировка пришла и от другого,
      // не забытого посетителя.
      for (const r of keep) quoted.delete(r.variant);
      const variants = f.variants.filter((v) => !quoted.has(v));
      await this.prisma.assistSiteFaq.updateMany({
        where: { id: f.id, siteId: ctx.siteId, accountId: ctx.accountId },
        data: {
          variants,
          variantRefs: keep.length
            ? (keep as unknown as Prisma.InputJsonValue)
            : Prisma.DbNull,
        },
      });
      if (variants.length !== f.variants.length && f.status !== 'archived') {
        if (this.golden) {
          // Новая версия знаний без цитаты (в индексе фрагмент FAQ несёт
          // варианты в тексте вопроса).
          await this.golden.core.reindexFaq(ctx, f.id, null);
        } else {
          this.logger.warn(
            `хвост forget: FAQ ${f.id} не переиндексирован — нет сервиса знаний`,
          );
        }
      }
    }
  }

  /**
   * Кластеры сайта после удаления элементов (forget, ретенция): размер и
   * посетители — по оставшимся, пустой — удалить, подпись удалённого
   * вопроса — заменить типичным из оставшихся.
   */
  async refreshClusters(ctx: {
    accountId: string;
    siteId: string;
  }): Promise<number> {
    // Счёт — в базе по ВСЕМ элементам кластера (не по выборке кластеризации:
    // её предел — свежие элементы, старый кластер иначе казался бы пустым).
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{
        id: string;
        label: string;
        size: number;
        visitors: number;
        labelAlive: boolean;
      }>
    >(
      `SELECT c."id", c."label",
              count(i."id")::int AS size,
              count(DISTINCT i."visitorId") FILTER (WHERE NOT i."suspicious")::int AS visitors,
              coalesce(bool_or(i."questionMasked" = c."label"), false) AS "labelAlive"
         FROM ${T.clusters} c
         LEFT JOIN ${T.items} i ON i."clusterId" = c."id" AND i."siteId" = c."siteId"
        WHERE c."siteId" = $1 AND c."accountId" = $2
        GROUP BY c."id", c."label"`,
      ctx.siteId,
      ctx.accountId,
    );
    let changed = 0;
    for (const c of rows) {
      if (c.size === 0) {
        await this.prisma.assistSiteLearningCluster.deleteMany({
          where: { id: c.id, siteId: ctx.siteId, accountId: ctx.accountId },
        });
        changed++;
        continue;
      }
      let label: string | null = null;
      if (!c.labelAlive) {
        const members = await this.prisma.$queryRawUnsafe<
          Array<Omit<ItemVec, 'embedding'> & { emb: string }>
        >(
          `SELECT "questionMasked", "createdAt", "questionEmbedding"::text AS emb
             FROM ${T.items}
            WHERE "siteId" = $1 AND "accountId" = $2 AND "clusterId" = $3
            ORDER BY "createdAt", "id" LIMIT 500`,
          ctx.siteId,
          ctx.accountId,
          c.id,
        );
        const list = members.map(({ emb, ...r }) => ({
          ...r,
          embedding: parseVector(emb),
        }));
        const centroid =
          (
            await this.loadClusters({
              ...ctx,
              enabled: true,
              knowledgeVersion: 0,
            })
          ).find((x) => x.id === c.id)?.centroid ?? [];
        label = typicalQuestion(
          list,
          centroid.length ? centroid : list[0].embedding,
        );
      }
      const res = await this.prisma.assistSiteLearningCluster.updateMany({
        where: {
          id: c.id,
          siteId: ctx.siteId,
          accountId: ctx.accountId,
          ...(label === null
            ? { NOT: { size: c.size, distinctVisitors: c.visitors } }
            : {}),
        },
        data: {
          size: c.size,
          distinctVisitors: c.visitors,
          ...(label !== null ? { label } : {}),
        },
      });
      changed += res.count;
    }
    return changed;
  }
}
