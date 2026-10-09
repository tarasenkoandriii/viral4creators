/**
 * Свёртки статистики — A (ТЗ §5-тер.10, §5-тер.14, §9.1). Основная роль.
 *  - rollupDay(siteId, day): пересчёт строки assist_site_daily_totals ЦЕЛИКОМ
 *    из источников (диалоги, сообщения, передачи, лиды, события целей,
 *    счётчики событий виджета, site_ai_usage) — идемпотентно (повтор не
 *    удваивает, §5-тер.16 п.17); сутки — в поясе сайта;
 *  - «решённый без человека» (§9.1): нет передачи, нет 👎, нет лида с
 *    пометкой «не ответили», тот же посетитель не вернулся с тем же
 *    вопросом за 24 ч (сигнал `unhappy:repeat` очереди L);
 *  - цели: stale — детектор не срабатывал 7 дней (у активной цели, у
 *    которой срабатывания были);
 *  - run (каждые 10 мин): пересчитать «сегодня» и «вчера» сайтов с
 *    активностью + экспорт (ExportsService.process);
 *  - daily (04:40 UTC): все сайты за прошедшие сутки, stale целей, уборка
 *    счётчиков событий старше 13 мес (Pro — 25, retention.ts).
 *
 * Уточнения A (формулы — в отчёте):
 *  - диалог дня — создан в сутки сайта, не `suspicious`;
 *  - «решённый» (§9.1): диалог закрыт (тишина ≥ 30 мин), есть ≥ 1 ответ
 *    (model|faq|cache), (а) нет передачи, кроме `cancelled` (согласовано
 *    с H: «любая передача диалога, кроме cancelled»), (б) нет лида в
 *    диалоге, где помощник «не знал» (ответ модели без источников), (в) нет
 *    👎, (г) тот же посетитель не задал похожий вопрос (триграммы ≥ 0.85 по
 *    маскированному тексту — решение 9 контракта) в течение 24 ч после
 *    исходного. (г) считается здесь по сообщениям, а не по таблице очереди L
 *    (контракт: «A не читает таблицы очереди напрямую»);
 *  - «не знал» (`unknown`) — ответ модели без источников;
 *  - конверсии дня — события целей по времени события (occurredAt) в
 *    сутки сайта; `refunded|cancelled` не считаются конверсией и деньгами,
 *    идут в `refunds` (возврат «вычитает», §5-тер.1); деньги — только в
 *    валюте цели (или сайта): другие валюты в Э3 не суммируются;
 *  - расход — site_ai_usage сайта по операциям обслуживания диалога
 *    (без индексации и «Админки»);
 *  - счётчики виджета (часы UTC) собираются в сутки сайта по началу часа.
 */
import { Injectable, Logger, Optional } from '@nestjs/common';
import { ANALYTICS_DEFAULTS } from '../../../config/assist-defaults';
import { PrismaService } from '../../../prisma/prisma.service';
import type { CronScope } from '../../../common/cron-scope';
import { ExportsService } from '../exports.service';
import { mergeNearestPage } from '../goal-page-merge';
import { seedDefaultGoals } from '../goals.service';
import {
  BASE_AGGREGATES_RETENTION_MS,
  aggregatesCutoff,
  cutoffDays,
  oldAggregateSites,
} from '../retention';
import { addDays, dayInTz, dayRangeUtc, siteTz, validDay } from '../site-time';

/** Операции обслуживания диалога (расход «Обзора»). */
export const DIALOG_COST_OPERATIONS = [
  'assist-chat',
  'assist-query-embed',
  'assist-classify',
  'assist-handoff',
  'assist-translate',
];

/** Порог «тот же вопрос» (решение 9 контракта: pg_trgm ≥ 0.85). */
export const REPEAT_SIMILARITY = 0.85;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** Окно «недавней активности» для крона run (сегодня + вчера с запасом). */
const ACTIVE_WINDOW_MS = 26 * HOUR_MS;
/** Детекторы, которые «ломаются» от смены вёрстки (stale имеет смысл). */
const PAGE_DETECTOR_JSON = ['url', 'click', 'form_submit'].map((k) =>
  JSON.stringify([{ kind: k }]),
);

export interface GoalDayTotals {
  direct: number;
  assisted: number;
  unassisted: number;
  unknown: number;
  refunds: number;
  value: { verified: number; page: number };
  currency: string | null;
}

export interface ProactiveDayTotals {
  shown: number;
  accepted: number;
  dismissed: number;
  dialogs: number;
  conversions: number;
}

const num = (v: unknown): number =>
  v === null || v === undefined ? 0 : Number(v);

@Injectable()
export class AnalyticsRollup {
  private readonly logger = new Logger(AnalyticsRollup.name);
  now: () => Date = () => new Date();

  constructor(
    readonly prisma: PrismaService,
    @Optional() private readonly exports?: ExportsService,
  ) {}

  async rollupDay(siteId: string, day: string): Promise<void> {
    if (!validDay(day)) throw new Error(`rollupDay: неверный день ${day}`);
    const site = await this.prisma.assistSite.findUnique({
      where: { siteId },
      select: { accountId: true, timezone: true, currency: true },
    });
    if (!site) return;
    const tz = siteTz(site.timezone);
    const { start, end } = dayRangeUtc(day, tz);
    const now = this.now();
    const p = this.prisma;

    const [dlg] = await p.$queryRawUnsafe<
      Array<{
        dialogs: bigint;
        resolved: bigint;
        answers: bigint;
        unknown: bigint;
        up: bigint;
        down: bigint;
      }>
    >(
      `WITH conv AS (
         SELECT c."id", c."visitorId", c."lastMessageAt"
           FROM "sites"."assist_site_conversations" c
          WHERE c."siteId" = $1 AND c."createdAt" >= $2 AND c."createdAt" < $3
            AND NOT c."suspicious"
       ),
       m AS (
         SELECT conv."id",
                count(*) FILTER (WHERE msg."role" = 'assistant'
                  AND msg."answerPath" IN ('model', 'faq', 'cache')
                  AND msg."streamState" IN ('complete', 'partial')) AS answers,
                count(*) FILTER (WHERE msg."role" = 'assistant' AND msg."answerPath" = 'model'
                  AND msg."streamState" IN ('complete', 'partial')
                  AND (msg."sources" IS NULL OR jsonb_typeof(msg."sources") <> 'array'
                       OR jsonb_array_length(msg."sources") = 0)) AS unknown,
                count(*) FILTER (WHERE msg."rating" = 1) AS up,
                count(*) FILTER (WHERE msg."rating" = -1) AS down
           FROM conv LEFT JOIN "sites"."assist_site_messages" msg ON msg."conversationId" = conv."id"
          GROUP BY conv."id"
       ),
       flags AS (
         SELECT conv."id",
                EXISTS (SELECT 1 FROM "sites"."assist_site_handoffs" h
                         WHERE h."conversationId" = conv."id" AND h."state" <> 'cancelled') AS handoff,
                EXISTS (SELECT 1 FROM "sites"."assist_site_leads" l
                         WHERE l."conversationId" = conv."id") AS lead,
                EXISTS (
                  SELECT 1 FROM "sites"."assist_site_messages" q1
                    JOIN "sites"."assist_site_conversations" c2
                      ON c2."siteId" = $1 AND c2."visitorId" = conv."visitorId"
                    JOIN "sites"."assist_site_messages" q2
                      ON q2."conversationId" = c2."id" AND q2."role" = 'visitor'
                   WHERE q1."conversationId" = conv."id" AND q1."role" = 'visitor'
                     AND q2."id" <> q1."id"
                     AND q2."createdAt" > q1."createdAt"
                     AND q2."createdAt" <= q1."createdAt" + interval '24 hours'
                     AND "extensions".similarity(q1."text", q2."text") >= $5
                ) AS repeat
           FROM conv
       )
       SELECT count(*) AS dialogs,
              count(*) FILTER (WHERE conv."lastMessageAt" < $4 AND m.answers > 0
                AND NOT f.handoff AND m.down = 0 AND NOT (f.lead AND m.unknown > 0)
                AND NOT f.repeat) AS resolved,
              COALESCE(sum(m.answers), 0) AS answers,
              COALESCE(sum(m.unknown), 0) AS unknown,
              COALESCE(sum(m.up), 0) AS up,
              COALESCE(sum(m.down), 0) AS down
         FROM conv JOIN m ON m."id" = conv."id" JOIN flags f ON f."id" = conv."id"`,
      siteId,
      start,
      end,
      new Date(now.getTime() - ANALYTICS_DEFAULTS.conversationIdleMs),
      REPEAT_SIMILARITY,
    );

    const [ho] = await p.$queryRawUnsafe<
      Array<{ handoffs: bigint; missed: bigint }>
    >(
      `SELECT count(*) FILTER (WHERE "state" <> 'cancelled') AS handoffs,
              count(*) FILTER (WHERE "state" = 'missed' OR "missedAt" IS NOT NULL) AS missed
         FROM "sites"."assist_site_handoffs"
        WHERE "siteId" = $1 AND "requestedAt" >= $2 AND "requestedAt" < $3`,
      siteId,
      start,
      end,
    );
    const [ld] = await p.$queryRawUnsafe<Array<{ leads: bigint }>>(
      `SELECT count(*) AS leads FROM "sites"."assist_site_leads"
        WHERE "siteId" = $1 AND "createdAt" >= $2 AND "createdAt" < $3`,
      siteId,
      start,
      end,
    );
    // Часы UTC, начало которых попадает в сутки сайта.
    const ev = await p.$queryRawUnsafe<
      Array<{ kind: string; key: string; n: bigint }>
    >(
      `SELECT "kind", "key", sum("count") AS n
         FROM "sites"."assist_site_event_counts"
        WHERE "siteId" = $1 AND "day" IN ($4, $5, $6)
          AND ("day"::date + make_interval(hours => "hour")) >= $2::timestamp
          AND ("day"::date + make_interval(hours => "hour")) < $3::timestamp
        GROUP BY "kind", "key"`,
      siteId,
      start.toISOString().replace('Z', ''),
      end.toISOString().replace('Z', ''),
      start.toISOString().slice(0, 10),
      addDays(start.toISOString().slice(0, 10), 1),
      end.toISOString().slice(0, 10),
    );
    const [cost] = await p.$queryRawUnsafe<Array<{ cost: bigint | null }>>(
      `SELECT sum("costMicroUsd") AS cost FROM "sites"."site_ai_usage"
        WHERE "siteId" = $1 AND "createdAt" >= $2 AND "createdAt" < $3
          AND "product" = 'assist' AND "operation" = ANY($4::text[])`,
      siteId,
      start,
      end,
      DIALOG_COST_OPERATIONS,
    );
    const goals = await p.$queryRawUnsafe<
      Array<{
        goalId: string;
        attribution: string;
        status: string;
        trust: string;
        n: bigint;
        value: string | null;
        currency: string | null;
      }>
    >(
      `SELECT e."goalId", e."attribution", e."status", e."trust", count(*) AS n,
              sum(e."value") FILTER (
                WHERE COALESCE(e."currency", g."currency", $4) = COALESCE(g."currency", $4)
              )::text AS value,
              COALESCE(g."currency", $4) AS currency
         FROM "sites"."assist_site_goal_events" e
         JOIN "sites"."assist_site_goals" g ON g."id" = e."goalId"
        WHERE e."siteId" = $1 AND e."occurredAt" >= $2 AND e."occurredAt" < $3
        GROUP BY e."goalId", e."attribution", e."status", e."trust", g."currency"`,
      siteId,
      start,
      end,
      site.currency,
    );
    const proDialogs = await p.$queryRawUnsafe<
      Array<{ key: string; n: bigint }>
    >(
      `SELECT substr("openedBy", 11) AS key, count(*) AS n
         FROM "sites"."assist_site_conversations"
        WHERE "siteId" = $1 AND "createdAt" >= $2 AND "createdAt" < $3
          AND NOT "suspicious" AND "openedBy" LIKE 'proactive:%'
        GROUP BY 1`,
      siteId,
      start,
      end,
    );
    const proGoals = await p.$queryRawUnsafe<Array<{ key: string; n: bigint }>>(
      `SELECT e."assist"->>'proactive' AS key, count(*) AS n
         FROM "sites"."assist_site_goal_events" e
        WHERE e."siteId" = $1 AND e."occurredAt" >= $2 AND e."occurredAt" < $3
          AND e."status" = 'completed' AND e."assist"->>'proactive' IS NOT NULL
        GROUP BY 1`,
      siteId,
      start,
      end,
    );

    const conversions: Record<string, GoalDayTotals> = {};
    for (const g of goals) {
      const t = (conversions[g.goalId] ??= {
        direct: 0,
        assisted: 0,
        unassisted: 0,
        unknown: 0,
        refunds: 0,
        value: { verified: 0, page: 0 },
        currency: g.currency,
      });
      const n = num(g.n);
      if (g.status !== 'completed') {
        t.refunds += n;
        continue;
      }
      if (g.attribution === 'direct') t.direct += n;
      else if (g.attribution === 'assisted') t.assisted += n;
      else if (g.attribution === 'unassisted') t.unassisted += n;
      else t.unknown += n;
      const v = g.value === null ? 0 : Number(g.value);
      if (g.trust === 'page') t.value.page = round2(t.value.page + v);
      else t.value.verified = round2(t.value.verified + v);
    }
    const count = (kind: string) =>
      ev.filter((e) => e.kind === kind).reduce((s, e) => s + num(e.n), 0);
    const proactive: Record<string, ProactiveDayTotals> = {};
    const pro = (key: string) =>
      (proactive[key] ??= {
        shown: 0,
        accepted: 0,
        dismissed: 0,
        dialogs: 0,
        conversions: 0,
      });
    for (const e of ev) {
      if (!e.key) continue;
      if (e.kind === 'proactive_shown') pro(e.key).shown += num(e.n);
      else if (e.kind === 'proactive_accepted') pro(e.key).accepted += num(e.n);
      else if (e.kind === 'proactive_dismissed')
        pro(e.key).dismissed += num(e.n);
    }
    for (const d of proDialogs) if (d.key) pro(d.key).dialogs += num(d.n);
    for (const g of proGoals) if (g.key) pro(g.key).conversions += num(g.n);

    const row = {
      dialogs: num(dlg?.dialogs),
      resolved: num(dlg?.resolved),
      answers: num(dlg?.answers),
      unknown: num(dlg?.unknown),
      handoffs: num(ho?.handoffs),
      handoffsMissed: num(ho?.missed),
      leads: num(ld?.leads),
      thumbsUp: num(dlg?.up),
      thumbsDown: num(dlg?.down),
      widgetViews: count('widget_view'),
      opens: count('open'),
      proactiveShown: count('proactive_shown'),
      proactiveAccepted: count('proactive_accepted'),
      costMicroUsd: BigInt(num(cost?.cost)),
      conversions: conversions as object,
      proactive: proactive as object,
      computedAt: now,
    };
    // Пересчёт строки ЦЕЛИКОМ: повтор не удваивает (§5-тер.16 п.17).
    await p.assistSiteDailyTotal.upsert({
      where: { siteId_day_group: { siteId, day, group: 'all' } },
      create: { accountId: site.accountId, siteId, day, group: 'all', ...row },
      update: row,
    });
  }

  /** Сайты с активностью за ~сутки (диалоги, цели, счётчики, передачи). */
  private async activeSites(now: Date, scope?: CronScope): Promise<string[]> {
    const since = new Date(now.getTime() - ACTIVE_WINDOW_MS);
    const yday = new Date(now.getTime() - DAY_MS).toISOString().slice(0, 10);
    const rows = await this.prisma.$queryRawUnsafe<Array<{ siteId: string }>>(
      `SELECT DISTINCT "siteId" FROM (
         SELECT "siteId" FROM "sites"."assist_site_conversations" WHERE "lastMessageAt" >= $1
         UNION SELECT "siteId" FROM "sites"."assist_site_goal_events" WHERE "receivedAt" >= $1
         UNION SELECT "siteId" FROM "sites"."assist_site_handoffs" WHERE "updatedAt" >= $1
         UNION SELECT "siteId" FROM "sites"."assist_site_leads" WHERE "createdAt" >= $1
         UNION SELECT "siteId" FROM "sites"."assist_site_event_counts" WHERE "day" >= $2
       ) s
       WHERE ($3::text[] IS NULL OR "siteId" = ANY($3::text[]))
       ORDER BY "siteId"`,
      since,
      yday,
      scope ? scope.siteIds : null,
    );
    return rows.map((r) => r.siteId);
  }

  /**
   * Слияние page-событий без orderId с verified той же цели (±30 мин), если
   * вебхук пришёл РАНЬШЕ страницы (§5-тер.16 п.5): verified-строки, ещё ни с
   * чем не слитые (атрибуция `unknown`), за последние 2 ч.
   */
  async mergePendingPageEvents(now: Date, scope?: CronScope): Promise<number> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT "id" FROM "sites"."assist_site_goal_events"
        WHERE "trust" = 'verified' AND "status" = 'completed'
          AND "attribution" = 'unknown' AND "conversationId" IS NULL
          AND "receivedAt" >= $1
          AND ($2::text[] IS NULL OR "siteId" = ANY($2::text[]))
        ORDER BY "receivedAt" LIMIT 500`,
      new Date(now.getTime() - 2 * HOUR_MS),
      scope ? scope.siteIds : null,
    );
    let merged = 0;
    for (const r of rows) {
      if (await mergeNearestPage(this.prisma, r.id)) merged++;
    }
    return merged;
  }

  /** lastFiredAt целей по событиям (роль виджета цели не пишет) + stale → active. */
  private async touchGoals(siteIds: string[], now: Date): Promise<void> {
    if (!siteIds.length) return;
    await this.prisma.$executeRawUnsafe(
      `UPDATE "sites"."assist_site_goals" g
          SET "lastFiredAt" = x.m,
              "status" = CASE WHEN g."status" = 'stale' AND x.m >= $2 THEN 'active' ELSE g."status" END,
              "updatedAt" = now()
         FROM (SELECT "goalId", max("occurredAt") AS m
                 FROM "sites"."assist_site_goal_events"
                WHERE "siteId" = ANY($1::text[]) AND "status" = 'completed'
                GROUP BY "goalId") x
        WHERE g."id" = x."goalId" AND (g."lastFiredAt" IS NULL OR g."lastFiredAt" < x.m)`,
      siteIds,
      new Date(now.getTime() - ANALYTICS_DEFAULTS.goalStaleAfterMs),
    );
  }

  /** `scope` — только тесты на общей базе (контракт Э3 §9 п.6). */
  async run(
    now: Date,
    scope?: CronScope,
  ): Promise<{ sites: number; exports: number }> {
    await this.mergePendingPageEvents(now, scope);
    const siteIds = await this.activeSites(now, scope);
    await this.touchGoals(siteIds, now);
    let sites = 0;
    for (const siteId of siteIds) {
      try {
        await this.rollupSite(siteId, now, [0, 1]);
        sites++;
      } catch (e) {
        this.logger.warn(
          `свёртка сайта ${siteId} не удалась (${(e as Error | null)?.name ?? 'Error'})`,
        );
      }
    }
    // Сайты с опубликованным видом без засеянных целей — «Заявка» с первого
    // дня (§5-тер.16 п.1; цели Э2 перенесены в Э3).
    await this.seedGoals(scope);
    const ex = this.exports
      ? await this.exports.process(
          ANALYTICS_DEFAULTS.exportsPerTick,
          now,
          scope,
        )
      : { done: 0, failed: 0, expired: 0 };
    return { sites, exports: ex.done };
  }

  private async rollupSite(
    siteId: string,
    now: Date,
    daysBack: number[],
  ): Promise<void> {
    const s = await this.prisma.assistSite.findUnique({
      where: { siteId },
      select: { timezone: true },
    });
    if (!s) return;
    const today = dayInTz(now, siteTz(s.timezone));
    for (const back of daysBack) {
      await this.rollupDay(siteId, addDays(today, -back));
    }
  }

  private async seedGoals(scope?: CronScope): Promise<number> {
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{ accountId: string; siteId: string }>
    >(
      `SELECT a."accountId", a."siteId" FROM "sites"."assist_sites" a
        WHERE a."widgetVersion" > 0
          AND ($1::text[] IS NULL OR a."siteId" = ANY($1::text[]))
          AND NOT EXISTS (
            SELECT 1 FROM "sites"."assist_site_goals" g
             WHERE g."siteId" = a."siteId" AND g."detectors" @> '[{"kind":"builtin"}]'::jsonb)
        LIMIT 200`,
      scope ? scope.siteIds : null,
    );
    let n = 0;
    for (const r of rows) {
      n += await seedDefaultGoals(this.prisma, r.accountId, r.siteId);
    }
    return n;
  }

  daily(
    now: Date,
    scope?: CronScope,
  ): Promise<{ sites: number; staleGoals: number }> {
    return this.dailyImpl(now, scope);
  }

  private async dailyImpl(
    now: Date,
    scope?: CronScope,
  ): Promise<{ sites: number; staleGoals: number }> {
    const sites = await this.prisma.assistSite.findMany({
      where: scope ? { siteId: { in: scope.siteIds } } : {},
      select: { siteId: true },
      orderBy: { siteId: 'asc' },
    });
    await this.touchGoals(
      sites.map((s) => s.siteId),
      now,
    );
    let done = 0;
    for (const s of sites) {
      try {
        // Вчера и позавчера: поздние события (вебхук, возврат) и закрытие
        // диалогов после полуночи.
        await this.rollupSite(s.siteId, now, [1, 2]);
        done++;
      } catch (e) {
        this.logger.warn(
          `суточная свёртка ${s.siteId} не удалась (${(e as Error | null)?.name ?? 'Error'})`,
        );
      }
    }
    const staleGoals = await this.prisma.$executeRawUnsafe(
      `UPDATE "sites"."assist_site_goals"
          SET "status" = 'stale', "updatedAt" = now()
        WHERE "status" = 'active' AND "lastFiredAt" IS NOT NULL AND "lastFiredAt" < $1
          AND ("detectors" @> $2::jsonb OR "detectors" @> $3::jsonb OR "detectors" @> $4::jsonb)
          AND ($5::text[] IS NULL OR "siteId" = ANY($5::text[]))`,
      new Date(now.getTime() - ANALYTICS_DEFAULTS.goalStaleAfterMs),
      PAGE_DETECTOR_JSON[0],
      PAGE_DETECTOR_JSON[1],
      PAGE_DETECTOR_JSON[2],
      scope ? scope.siteIds : null,
    );
    // Хранение (§5-тер.15): счётчики и свёртки — 13 мес (Pro — 25, по
    // тарифу на момент уборки, заход 9), события целей — 13 мес у всех.
    const ids = scope ? scope.siteIds : null;
    const tables = ['assist_site_event_counts', 'assist_site_daily_totals'];
    const base = new Date(now.getTime() - BASE_AGGREGATES_RETENTION_MS)
      .toISOString()
      .slice(0, 10);
    const cutoff = await aggregatesCutoff(
      this.prisma,
      await oldAggregateSites(this.prisma, tables, base, ids),
      now,
    );
    const cut = cutoffDays(cutoff);
    for (const t of tables) {
      await this.prisma.$executeRawUnsafe(
        `DELETE FROM "sites"."${t}"
          WHERE "day" < $1 AND ($2::text[] IS NULL OR "siteId" = ANY($2::text[]))
            AND ("day" < $3 OR NOT ("siteId" = ANY($4::text[])))`,
        cut.base,
        ids,
        cut.long,
        cutoff.longSiteIds,
      );
    }
    await this.prisma.$executeRawUnsafe(
      `DELETE FROM "sites"."assist_site_goal_events"
        WHERE "occurredAt" < $1 AND ($2::text[] IS NULL OR "siteId" = ANY($2::text[]))`,
      new Date(now.getTime() - ANALYTICS_DEFAULTS.goalEventsRetentionMs),
      ids,
    );
    this.logger.log(`суточная свёртка: сайтов ${done}, stale ${staleGoals}`);
    return { sites: done, staleGoals };
  }
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
