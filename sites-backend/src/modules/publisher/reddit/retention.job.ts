/**
 * AI Publisher, P-R M2 — задание `reddit-retention` (daily;
 * reddit-manual-mvp-adapted.md §4 «reddit_excerpt_retention_days», хвост
 * M2 (2); Р-RD-59). Собственное задание пакета, не общий `housekeeping`:
 * `pub_sources` пишет P-B1 — через `SourcesService.redactRedditExcerpt`
 * (единственный путь правки доказательства P-R в гварде).
 *
 * Отбор — в SQL (срок по параметру продукта, нет неархивного брифа),
 * курсором пачками до исчерпания (Р-RD-71). Выход генераций брифов треда в
 * журнале AI, цитирующий выдержку, маскируется (Р-RD-70).
 *
 * Тред (`threadUrl`) обрабатывается, когда ВСЕ его возможности в продукте
 * `archived|skipped` и у каждой прошло `reddit_excerpt_retention_days`
 * календарных дней Kyiv от `updatedAt`, а их брифы архивированы (или их
 * нет): фрагмент всех выдержек треда (`origin=reddit`, `discussion`) →
 * плейсхолдер с новым `contentHash`, `context` архивных брифов — тоже;
 * копии этих текстов в сохранённых ответах мутаций
 * (`pub_idempotency_keys.responseBody`) заменяются (`redactStoredResponses`,
 * ядро). Аудит `erase` на каждый источник и бриф. Продукты `eval|restored`
 * не обрабатываются; архивные — обрабатываются (раунд 2 M2 S3-6, Р-RD-84:
 * приватность важнее «заморозки» архива). Повтор — no-op.
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { SitesDb } from '../../../prisma/sites-db.service';
import { REDDIT_RETENTION_PLACEHOLDER } from '../contracts/reddit-api';
import { SourcesService } from '../content/sources.service';
import { PubContribution } from '../core/contributions';
import { addKyivCalendarDays } from '../core/kyiv-time';
import { redactStoredResponses, scrubStoredResponses } from '../core/operation';
import { overlapMatcher, redactAiCallsOf, scrubJson } from '../ai/ai-redaction';
import { briefVersionIds } from './brief-views';
import {
  PubPorts,
  type CronJob,
  type CronResult,
  type ProductRef,
  type PubCronContext,
  type PubTx,
} from '../core/ports';

export const RETENTION_DAYS_DEFAULT = 180;
const ACTOR = 'system:reddit-retention';
const BATCH = 200;

/** Действующее значение `reddit_excerpt_retention_days` (иначе 180). */
export function retentionDaysOf(value: unknown): number {
  const d = (value as { days?: unknown } | null)?.days;
  return typeof d === 'number' && Number.isInteger(d) && d >= 1 && d <= 3650
    ? d
    : RETENTION_DAYS_DEFAULT;
}

export interface RetentionOutcome {
  status: 'redacted' | 'not_due' | 'active_brief' | 'nothing';
  sources: number;
  briefs: number;
  responses: number;
  aiCalls: number;
}

@Injectable()
@PubContribution('cron-job')
export class RedditRetentionJob implements CronJob {
  readonly key = 'reddit-retention';
  readonly schedule = 'daily' as const;

  constructor(
    private readonly db: SitesDb,
    private readonly sources: SourcesService,
    private readonly ports: PubPorts,
  ) {}

  /** Размер пачки отбора (тест уменьшает). */
  batchSize = BATCH;

  /**
   * Аудит M2 S2-4 (Р-RD-71): отбор — только треды, срок которых ВЫШЕЛ
   * (все возможности треда `archived|skipped` дольше параметра продукта по
   * календарю Kyiv) и без неархивного брифа; курсор `(accountId, productId,
   * threadUrl)` — пачками до исчерпания или срока задания.
   */
  async run(ctx: PubCronContext): Promise<CronResult> {
    const system = this.db.system(
      'крон publisher reddit-retention: выдержки тредов архивных возможностей всех кабинетов',
    );
    const scope = ctx.scope
      ? Prisma.sql`AND p."siteId" = ANY(${ctx.scope.siteIds}::text[])`
      : Prisma.empty;
    const reviewTasksCreated = await this.reviewHeldThreads(ctx);
    const totals = {
      reviewTasksCreated,
      threads: 0,
      sourcesRedacted: 0,
      briefsRedacted: 0,
      responsesRedacted: 0,
      aiCallsRedacted: 0,
      notDue: 0,
      activeBrief: 0,
      batches: 0,
    };
    let cursor = { a: '', p: '', t: '' };
    for (;;) {
      if (Date.now() > ctx.deadline.getTime()) break;
      const due = await system.$queryRaw<
        Array<{ accountId: string; productId: string; threadUrl: string }>
      >`
        WITH days AS (
          SELECT p."id" AS "productId",
                 CASE WHEN jsonb_typeof(prm."value" -> 'days') = 'number'
                       AND (prm."value" ->> 'days')::numeric BETWEEN 1 AND 3650
                       AND (prm."value" ->> 'days')::numeric = trunc((prm."value" ->> 'days')::numeric)
                      THEN (prm."value" ->> 'days')::int ELSE ${RETENTION_DAYS_DEFAULT}::int END AS d
            FROM "sites"."pub_products" p
            LEFT JOIN "sites"."pub_parameters" prm
              ON prm."productId" = p."id" AND prm."key" = 'reddit_excerpt_retention_days'
             AND prm."status" IN ('assumption', 'approved')
           WHERE p."kind" IN ('working', 'test') ${scope}
        )
        SELECT DISTINCT o."accountId", o."productId", o."threadUrl"
          FROM "sites"."pub_reddit_opportunities" o
          JOIN days ON days."productId" = o."productId"
         WHERE (o."accountId", o."productId", o."threadUrl") > (${cursor.a}, ${cursor.p}, ${cursor.t})
           AND EXISTS (SELECT 1 FROM "sites"."pub_sources" s
                        WHERE s."productId" = o."productId" AND s."origin" = 'reddit'
                          AND s."kind" = 'discussion' AND s."url" = o."threadUrl"
                          AND s."fragment" <> ${REDDIT_RETENTION_PLACEHOLDER})
           AND NOT EXISTS (
                 SELECT 1 FROM "sites"."pub_reddit_opportunities" o2
                  WHERE o2."productId" = o."productId" AND o2."threadUrl" = o."threadUrl"
                    AND (o2."status" NOT IN ('archived', 'skipped')
                         OR ((o2."updatedAt" AT TIME ZONE 'Europe/Kyiv') + make_interval(days => days.d))
                              AT TIME ZONE 'Europe/Kyiv' > ${ctx.now}))
           AND NOT EXISTS (
                 SELECT 1 FROM "sites"."pub_reddit_briefs" b
                   JOIN "sites"."pub_reddit_opportunities" o3 ON o3."id" = b."opportunityId"
                  WHERE o3."productId" = o."productId" AND o3."threadUrl" = o."threadUrl"
                    AND b."status" <> 'archived')
         ORDER BY o."accountId", o."productId", o."threadUrl"
         LIMIT ${this.batchSize}`;
      totals.batches++;
      for (const d of due) {
        if (Date.now() > ctx.deadline.getTime()) break;
        const r = await this.db
          .forAccount(d.accountId)
          .$transaction((tx) =>
            this.redactThread(
              tx as unknown as PubTx,
              { id: d.productId, accountId: d.accountId },
              d.threadUrl,
              ctx.now,
            ),
          );
        if (r.status === 'redacted') totals.threads++;
        if (r.status === 'not_due') totals.notDue++;
        if (r.status === 'active_brief') totals.activeBrief++;
        totals.sourcesRedacted += r.sources;
        totals.briefsRedacted += r.briefs;
        totals.responsesRedacted += r.responses;
        totals.aiCallsRedacted += r.aiCalls;
        cursor = { a: d.accountId, p: d.productId, t: d.threadUrl };
      }
      if (due.length < this.batchSize) break;
    }
    return { processed: totals.threads, details: totals };
  }

  /** Р-RD-AUD-6: stale active evidence needs a human decision, never auto-archive. */
  async reviewHeldThreads(ctx: PubCronContext): Promise<number> {
    if (Date.now() > ctx.deadline.getTime()) return 0;
    const scope = ctx.scope
      ? Prisma.sql`AND p."siteId" = ANY(${ctx.scope.siteIds}::text[])`
      : Prisma.empty;
    const rows = await this.db.system('reddit-retention: review held evidence')
      .$queryRaw<
      Array<{
        accountId: string;
        productId: string;
        id: string;
        triggerRef: string;
      }>
    >`
      WITH held AS (
        SELECT o."accountId", o."productId", o."id",
               GREATEST(o."updatedAt", max(b."updatedAt")) AS activity,
               CASE WHEN jsonb_typeof(prm."value" -> 'days') = 'number'
                     AND (prm."value" ->> 'days')::numeric BETWEEN 1 AND 3650
                     AND (prm."value" ->> 'days')::numeric = trunc((prm."value" ->> 'days')::numeric)
                    THEN (prm."value" ->> 'days')::int ELSE ${RETENTION_DAYS_DEFAULT}::int END AS days
          FROM "sites"."pub_reddit_opportunities" o
          JOIN "sites"."pub_products" p ON p."id" = o."productId"
          LEFT JOIN "sites"."pub_parameters" prm ON prm."productId" = p."id"
            AND prm."key" = 'reddit_excerpt_retention_days' AND prm."status" IN ('assumption', 'approved')
          LEFT JOIN "sites"."pub_reddit_briefs" b ON b."opportunityId" = o."id" AND b."productId" = o."productId"
         WHERE p."kind" IN ('working', 'test') ${scope}
           AND EXISTS (SELECT 1 FROM "sites"."pub_sources" s
             WHERE s."productId" = o."productId" AND s."origin" = 'reddit'
               AND s."kind" = 'discussion' AND s."url" = o."threadUrl"
               AND s."fragment" <> ${REDDIT_RETENTION_PLACEHOLDER})
         GROUP BY o."id", o."accountId", o."productId", o."updatedAt", o."status", prm."value"
        HAVING o."status" NOT IN ('archived', 'skipped') OR bool_or(b."status" <> 'archived')
      ), due AS (
        SELECT *, 'reddit-retention:' || floor(extract(epoch FROM activity) * 1000)::text || ':' || days::text AS ref
          FROM held WHERE ((activity AT TIME ZONE 'Europe/Kyiv') + make_interval(days => days)) AT TIME ZONE 'Europe/Kyiv' <= ${ctx.now}
      )
      SELECT d."accountId", d."productId", d."id", d.ref AS "triggerRef" FROM due d
       WHERE NOT EXISTS (SELECT 1 FROM "sites"."pub_review_tasks" t
         WHERE t."productId" = d."productId" AND t."objectType" = 'reddit_opportunity'
           AND t."objectId" = d."id" AND t."reason" = 'retention_review' AND t."triggerRef" = d.ref)
       ORDER BY d.activity, d."id" LIMIT ${this.batchSize}`;
    let created = 0;
    for (const row of rows) {
      if (Date.now() > ctx.deadline.getTime()) break;
      created += await this.db.forAccount(row.accountId).$transaction((tx) =>
        this.ports.review().open(
          tx as unknown as PubTx,
          { id: row.productId, accountId: row.accountId },
          [
            {
              objectType: 'reddit_opportunity',
              objectId: row.id,
              reason: 'retention_review',
              triggerRef: row.triggerRef,
              severity: 'normal',
            },
          ],
          { actor: ACTOR },
        ),
      );
    }
    return created;
  }

  /** Один тред продукта (в транзакции кабинета). */
  async redactThread(
    tx: PubTx,
    product: ProductRef,
    threadUrl: string,
    now: Date,
  ): Promise<RetentionOutcome> {
    const none = { sources: 0, briefs: 0, responses: 0, aiCalls: 0 };
    const param = await tx.pubParameter.findFirst({
      where: {
        productId: product.id,
        key: 'reddit_excerpt_retention_days',
        status: { in: ['assumption', 'approved'] },
      },
      select: { value: true },
    });
    const days = retentionDaysOf(param?.value ?? null);
    const opps = await tx.pubRedditOpportunity.findMany({
      where: { productId: product.id, threadUrl },
      select: { id: true, status: true, updatedAt: true },
    });
    const due = opps.every(
      (o) =>
        (o.status === 'archived' || o.status === 'skipped') &&
        addKyivCalendarDays(o.updatedAt, days).getTime() <= now.getTime(),
    );
    if (!opps.length || !due) return { status: 'not_due', ...none };
    const briefs = await tx.pubRedditBrief.findMany({
      where: {
        productId: product.id,
        opportunityId: { in: opps.map((o) => o.id) },
      },
      select: { id: true, status: true, context: true },
    });
    if (briefs.some((b) => b.status !== 'archived'))
      return { status: 'active_brief', ...none };
    const sources = await tx.pubSource.findMany({
      where: {
        productId: product.id,
        origin: 'reddit',
        kind: 'discussion',
        url: threadUrl,
        fragment: { not: REDDIT_RETENTION_PLACEHOLDER },
      },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    const old: string[] = [];
    const audit = this.ports.audit();
    let redacted = 0;
    for (const s of sources) {
      const prev = await this.sources.redactRedditExcerpt(
        tx,
        product,
        s.id,
        REDDIT_RETENTION_PLACEHOLDER,
      );
      if (prev === null) continue;
      redacted++;
      old.push(prev);
      await audit.write(tx, {
        accountId: product.accountId,
        productId: product.id,
        actor: ACTOR,
        objectType: 'source',
        objectId: s.id,
        action: 'erase',
        meta: {
          reason: 'reddit_retention',
          retentionDays: days,
          opportunityIds: opps.map((o) => o.id),
        },
        occurredAt: now,
      });
    }
    let briefCount = 0;
    for (const b of briefs) {
      if (!b.context || b.context === REDDIT_RETENTION_PLACEHOLDER) continue;
      const n = await tx.pubRedditBrief.updateMany({
        where: { id: b.id, productId: product.id, status: 'archived' },
        data: {
          context: REDDIT_RETENTION_PLACEHOLDER,
          revision: { increment: 1 },
        },
      });
      if (n.count !== 1) continue;
      briefCount++;
      old.push(b.context);
      await audit.write(tx, {
        accountId: product.accountId,
        productId: product.id,
        actor: ACTOR,
        objectType: 'reddit_brief',
        objectId: b.id,
        action: 'erase',
        meta: { reason: 'reddit_retention', field: 'context' },
        occurredAt: now,
      });
    }
    let responses = await redactStoredResponses(
      tx,
      product,
      old,
      REDDIT_RETENTION_PLACEHOLDER,
    );
    // Аудит M2 S3-9 (Р-RD-70): выход генераций брифов треда, цитирующий
    // выдержку, — тоже плейсхолдер (журнал AI и сохранённые ответы
    // `…/generate`); статус и стоимость вызовов не меняются.
    const calls = [
      ...(await redactAiCallsOf(
        tx,
        product,
        'reddit_brief',
        briefs.map((b) => b.id),
        old,
        REDDIT_RETENTION_PLACEHOLDER,
      )),
      // Задачи «переписать абзац» черновиков этих брифов (Р-RD-83).
      ...(await redactAiCallsOf(
        tx,
        product,
        'content_version',
        await briefVersionIds(
          tx,
          product.id,
          briefs.map((b) => b.id),
        ),
        old,
        REDDIT_RETENTION_PLACEHOLDER,
      )),
    ];
    if (calls.length) {
      const hit = overlapMatcher(old);
      responses += await scrubStoredResponses(tx, product, calls, (v) =>
        scrubJson(v, hit, REDDIT_RETENTION_PLACEHOLDER),
      );
    }
    return {
      status: redacted || briefCount || calls.length ? 'redacted' : 'nothing',
      sources: redacted,
      briefs: briefCount,
      responses,
      aiCalls: calls.length,
    };
  }
}
