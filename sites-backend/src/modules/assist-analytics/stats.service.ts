/**
 * Экран «Статистика» — A (ТЗ §5-тер.6; §9.1): Обзор, Конверсии, Темы
 * (кластеры — LearningReadApi, L), сводка сайтов кабинета. Только из
 * assist_site_daily_totals (+ события целей за открытое окно) — ответ ≤ 1 с
 * на 13 месяцах. «Диалоги» — лента H (`GET …/conversations`), не здесь.
 * Права (§5-тер.13): владелец, assist: manager — всё; operator — только
 * свои передачи и лиды, без денег (overview с урезанными полями или 403
 * на conversions — решение A, записать в отчёт).
 *
 * Решение A по оператору (О-12): все маршруты статистики — assist: manager
 * (оператор получает 403); его экран — лента своих передач H. Свёртка
 * сайтовая, «свои передачи» в ней не выделить без нового измерения.
 *
 * Уточнения A:
 *  - период — дни сайта `from..to` включительно, ≤ 400 дней; сравнение
 *    `prev` — предыдущий период той же длины;
 *  - «в пределах шума» — тест двух долей (z, p > 0.05) для долей (решённые,
 *    👍); у счётчиков — null;
 *  - окно атрибуции в режиме «без согласия» — документ (≤ 30 мин), значит
 *    «ещё открыто» только у сегодняшнего дня сайта;
 *  - Темы — только из LearningReadApi (A не читает таблицы очереди L);
 *    конверсии темы — события целей direct|assisted её диалогов.
 */
import { HttpStatus, Injectable, Optional } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SitesDb } from '../../prisma/sites-db.service';
import { LearningReadApi } from '../assist-site-learning/learning-read.service';
import type { AccountMembership } from '../site-core/account/roles';
import { effectiveAnalyticsConfig } from './analytics-config';
import { analyticsError, notFoundSite } from './analytics-errors';
import type {
  MetricView,
  StatsConversionsView,
  StatsOverviewView,
  StatsPeriod,
  StatsSitesView,
  StatsTopicsView,
} from './api-types';
import { sumConversions } from './exports.service';
import {
  addDays,
  dayInTz,
  dayRangeUtc,
  daysBetween,
  siteTz,
  validDay,
} from './site-time';

export interface StatsQuery {
  from: string;
  to: string;
  compare: 'prev' | 'none';
}

export const STATS_MAX_DAYS = 400;

type Db = ReturnType<SitesDb['forAccount']>;

interface DayRow {
  day: string;
  dialogs: number;
  resolved: number;
  answers: number;
  unknown: number;
  handoffs: number;
  handoffsMissed: number;
  leads: number;
  thumbsUp: number;
  thumbsDown: number;
  costMicroUsd: bigint;
  conversions: unknown;
  proactive: unknown;
}

/** Разбор query: дни, порядок, длина, compare. */
export function parseStatsQuery(q: unknown): StatsQuery {
  const o = (q && typeof q === 'object' ? q : {}) as Record<string, unknown>;
  if (!validDay(o.from) || !validDay(o.to) || o.from > o.to) {
    throw analyticsError(
      HttpStatus.BAD_REQUEST,
      'STATS_RANGE_INVALID',
      'Период: from ≤ to, дни YYYY-MM-DD',
    );
  }
  if (addDays(o.from, STATS_MAX_DAYS) <= o.to) {
    throw analyticsError(
      HttpStatus.BAD_REQUEST,
      'STATS_RANGE_INVALID',
      `Период не длиннее ${STATS_MAX_DAYS} дней`,
    );
  }
  const compare =
    o.compare === undefined || o.compare === 'prev'
      ? 'prev'
      : o.compare === 'none'
        ? 'none'
        : null;
  if (!compare) {
    throw analyticsError(
      HttpStatus.BAD_REQUEST,
      'STATS_RANGE_INVALID',
      'compare: prev | none',
    );
  }
  return { from: o.from, to: o.to, compare };
}

/** Предыдущий период той же длины. */
export function prevPeriod(
  from: string,
  to: string,
): { from: string; to: string } {
  const len = daysBetween(from, to).length;
  return { from: addDays(from, -len), to: addDays(from, -1) };
}

/** Двусторонний тест двух долей: p-значение (нормальное приближение). */
export function twoProportionP(
  x1: number,
  n1: number,
  x2: number,
  n2: number,
): number | null {
  if (n1 <= 0 || n2 <= 0) return null;
  const p = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  if (se === 0) return x1 / n1 === x2 / n2 ? 1 : 0;
  const z = Math.abs(x1 / n1 - x2 / n2) / se;
  return 2 * (1 - normalCdf(z));
}

function normalCdf(z: number): number {
  // Абрамовиц–Стиган 7.1.26: погрешность < 1.5e-7 — для «шум/не шум» с запасом.
  const t = 1 / (1 + 0.3275911 * (z / Math.SQRT2));
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) *
      t +
      0.254829592) *
      t *
      Math.exp(-(z * z) / 2);
  return 0.5 * (1 + y);
}

export function metric(value: number, prev: number | null): MetricView {
  return {
    value,
    prev,
    deltaPct:
      prev === null || prev === 0
        ? null
        : Math.round(((value - prev) / prev) * 1000) / 10,
    noise: null,
  };
}

export function shareMetric(
  x: number,
  n: number,
  px: number | null,
  pn: number | null,
): MetricView {
  const value = n > 0 ? round4(x / n) : 0;
  const prev = px !== null && pn !== null && pn > 0 ? round4(px / pn) : null;
  const m = metric(value, prev);
  if (px !== null && pn !== null) {
    const p = twoProportionP(x, n, px, pn);
    m.noise = p === null ? null : p > 0.05;
  }
  return m;
}

function round4(v: number): number {
  return Math.round(v * 10_000) / 10_000;
}

interface Totals {
  dialogs: number;
  resolved: number;
  unknown: number;
  answers: number;
  handoffs: number;
  handoffsMissed: number;
  leads: number;
  up: number;
  down: number;
  cost: number;
  direct: number;
  assisted: number;
  conversions: number;
}

function totals(rows: DayRow[]): Totals {
  const t: Totals = {
    dialogs: 0,
    resolved: 0,
    unknown: 0,
    answers: 0,
    handoffs: 0,
    handoffsMissed: 0,
    leads: 0,
    up: 0,
    down: 0,
    cost: 0,
    direct: 0,
    assisted: 0,
    conversions: 0,
  };
  for (const r of rows) {
    t.dialogs += r.dialogs;
    t.resolved += r.resolved;
    t.unknown += r.unknown;
    t.answers += r.answers;
    t.handoffs += r.handoffs;
    t.handoffsMissed += r.handoffsMissed;
    t.leads += r.leads;
    t.up += r.thumbsUp;
    t.down += r.thumbsDown;
    t.cost += Number(r.costMicroUsd);
    const c = sumConversions(r.conversions);
    t.direct += c.direct;
    t.assisted += c.assisted;
    t.conversions += c.direct + c.assisted + c.unassisted + c.unknown;
  }
  return t;
}

@Injectable()
export class StatsService {
  now: () => Date = () => new Date();

  constructor(
    private readonly sitesDb: SitesDb,
    private readonly prisma: PrismaService,
    @Optional() private readonly learning?: LearningReadApi,
  ) {}

  private async site(m: AccountMembership, siteId: string) {
    const db = this.sitesDb.forAccount(m.accountId);
    const site = await db.site.findFirst({
      where: { id: siteId },
      select: { id: true, name: true },
    });
    if (!site) throw notFoundSite();
    const a = await db.assistSite.findFirst({
      where: { siteId },
      select: { timezone: true, currency: true, analytics: true },
    });
    return {
      db,
      name: site.name,
      tz: siteTz(a?.timezone),
      currency: a?.currency ?? 'UAH',
      analytics: a?.analytics ?? null,
    };
  }

  private async days(
    db: Db,
    siteId: string,
    from: string,
    to: string,
  ): Promise<DayRow[]> {
    return db.assistSiteDailyTotal.findMany({
      where: { siteId, group: 'all', day: { gte: from, lte: to } },
      orderBy: { day: 'asc' },
      select: {
        day: true,
        dialogs: true,
        resolved: true,
        answers: true,
        unknown: true,
        handoffs: true,
        handoffsMissed: true,
        leads: true,
        thumbsUp: true,
        thumbsDown: true,
        costMicroUsd: true,
        conversions: true,
        proactive: true,
      },
    });
  }

  private period(q: StatsQuery, tz: string): StatsPeriod {
    const today = dayInTz(this.now(), tz);
    return {
      from: q.from,
      to: q.to,
      attributionWindowOpenFrom:
        q.to >= today && q.from <= today ? today : null,
      timezone: tz,
    };
  }

  async overview(
    m: AccountMembership,
    siteId: string,
    q: StatsQuery,
  ): Promise<StatsOverviewView> {
    const query = parseStatsQuery(q);
    const s = await this.site(m, siteId);
    const rows = await this.days(s.db, siteId, query.from, query.to);
    const t = totals(rows);
    let p: Totals | null = null;
    if (query.compare === 'prev') {
      const pp = prevPeriod(query.from, query.to);
      p = totals(await this.days(s.db, siteId, pp.from, pp.to));
    }
    const cfg = effectiveAnalyticsConfig(s.analytics);
    const byDay = new Map(rows.map((r) => [r.day, r]));
    return {
      period: this.period(query, s.tz),
      dialogs: metric(t.dialogs, p?.dialogs ?? null),
      resolved: metric(t.resolved, p?.resolved ?? null),
      resolvedShare: shareMetric(
        t.resolved,
        t.dialogs,
        p?.resolved ?? null,
        p?.dialogs ?? null,
      ),
      operatorHoursSaved:
        Math.round((t.resolved * cfg.minutesPerQuestion) / 6) / 10,
      minutesPerQuestion: cfg.minutesPerQuestion,
      handoffs: metric(t.handoffs, p?.handoffs ?? null),
      handoffsMissed: metric(t.handoffsMissed, p?.handoffsMissed ?? null),
      leads: metric(t.leads, p?.leads ?? null),
      conversions: {
        total: metric(t.conversions, p?.conversions ?? null),
        direct: metric(t.direct, p?.direct ?? null),
        assisted: metric(t.assisted, p?.assisted ?? null),
      },
      thumbsUpShare: shareMetric(
        t.up,
        t.up + t.down,
        p ? p.up : null,
        p ? p.up + p.down : null,
      ),
      costMicroUsd: t.cost,
      series: daysBetween(query.from, query.to).map((day) => {
        const r = byDay.get(day);
        const c = r ? sumConversions(r.conversions) : null;
        return {
          day,
          dialogs: r?.dialogs ?? 0,
          resolved: r?.resolved ?? 0,
          handoffs: r?.handoffs ?? 0,
          leads: r?.leads ?? 0,
          conversions: c ? c.direct + c.assisted + c.unassisted + c.unknown : 0,
        };
      }),
    };
  }

  async conversions(
    m: AccountMembership,
    siteId: string,
    q: StatsQuery,
  ): Promise<StatsConversionsView> {
    const query = parseStatsQuery(q);
    const s = await this.site(m, siteId);
    const rows = await this.days(s.db, siteId, query.from, query.to);
    const goals = await s.db.assistSiteGoal.findMany({
      where: { siteId },
      select: { id: true, key: true, name: true, currency: true },
      orderBy: [{ createdAt: 'asc' }, { key: 'asc' }],
    });
    const dialogs = rows.reduce((a, r) => a + r.dialogs, 0);
    const per = new Map<
      string,
      {
        direct: number;
        assisted: number;
        unassisted: number;
        unknown: number;
        refunds: number;
        verified: number;
        page: number;
      }
    >();
    const proactive = new Map<
      string,
      {
        shown: number;
        accepted: number;
        dismissed: number;
        dialogs: number;
        conversions: number;
      }
    >();
    for (const r of rows) {
      const conv = (
        r.conversions && typeof r.conversions === 'object' ? r.conversions : {}
      ) as Record<string, unknown>;
      for (const [goalId, v] of Object.entries(conv)) {
        const one = sumConversions({ [goalId]: v });
        const acc = per.get(goalId) ?? {
          direct: 0,
          assisted: 0,
          unassisted: 0,
          unknown: 0,
          refunds: 0,
          verified: 0,
          page: 0,
        };
        acc.direct += one.direct;
        acc.assisted += one.assisted;
        acc.unassisted += one.unassisted;
        acc.unknown += one.unknown;
        acc.refunds += one.refunds;
        acc.verified = Math.round((acc.verified + one.verified) * 100) / 100;
        acc.page = Math.round((acc.page + one.page) * 100) / 100;
        per.set(goalId, acc);
      }
      const pro = (
        r.proactive && typeof r.proactive === 'object' ? r.proactive : {}
      ) as Record<string, Record<string, unknown>>;
      for (const [key, v] of Object.entries(pro)) {
        const n = (x: unknown) => (typeof x === 'number' ? x : 0);
        const acc = proactive.get(key) ?? {
          shown: 0,
          accepted: 0,
          dismissed: 0,
          dialogs: 0,
          conversions: 0,
        };
        acc.shown += n(v?.shown);
        acc.accepted += n(v?.accepted);
        acc.dismissed += n(v?.dismissed);
        acc.dialogs += n(v?.dialogs);
        acc.conversions += n(v?.conversions);
        proactive.set(key, acc);
      }
    }
    return {
      period: this.period(query, s.tz),
      goals: goals.map((g) => {
        const c = per.get(g.id) ?? {
          direct: 0,
          assisted: 0,
          unassisted: 0,
          unknown: 0,
          refunds: 0,
          verified: 0,
          page: 0,
        };
        return {
          goalId: g.id,
          key: g.key,
          name: g.name,
          total: c.direct + c.assisted + c.unassisted + c.unknown,
          direct: c.direct,
          assisted: c.assisted,
          unassisted: c.unassisted,
          refunds: c.refunds,
          value: {
            verified: c.verified,
            page: c.page,
            currency: g.currency ?? s.currency,
          },
          dialogConversion:
            dialogs > 0 ? round4((c.direct + c.assisted) / dialogs) : null,
        };
      }),
      proactive: [...proactive.entries()]
        .sort((a, b) => b[1].shown - a[1].shown || a[0].localeCompare(b[0]))
        .map(([key, v]) => ({ key, ...v })),
    };
  }

  async topics(
    m: AccountMembership,
    siteId: string,
    q: StatsQuery,
  ): Promise<StatsTopicsView> {
    const query = parseStatsQuery(q);
    const s = await this.site(m, siteId);
    const from = dayRangeUtc(query.from, s.tz).start;
    const to = dayRangeUtc(query.to, s.tz).end;
    const facts = this.learning
      ? await this.learning.topics({
          accountId: m.accountId,
          siteId,
          from,
          to,
          limit: 50,
        })
      : [];
    const topics: StatsTopicsView['topics'] = [];
    for (const f of facts) {
      const ids = f.conversationIds.slice(0, 5000);
      let conversions = 0;
      let unknownShare = 0;
      if (ids.length) {
        const [c] = await this.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
          `SELECT count(*) AS n FROM "sites"."assist_site_goal_events"
            WHERE "siteId" = $1 AND "conversationId" = ANY($2::text[])
              AND "status" = 'completed' AND "attribution" IN ('direct', 'assisted')`,
          siteId,
          ids,
        );
        conversions = Number(c?.n ?? 0);
        const [u] = await this.prisma.$queryRawUnsafe<
          Array<{ a: bigint; u: bigint }>
        >(
          `SELECT count(*) AS a,
                  count(*) FILTER (WHERE "answerPath" = 'model'
                    AND ("sources" IS NULL OR jsonb_typeof("sources") <> 'array'
                         OR jsonb_array_length("sources") = 0)) AS u
             FROM "sites"."assist_site_messages"
            WHERE "siteId" = $1 AND "conversationId" = ANY($2::text[])
              AND "role" = 'assistant' AND "answerPath" IN ('model', 'faq', 'cache')`,
          siteId,
          ids,
        );
        const a = Number(u?.a ?? 0);
        unknownShare = a > 0 ? round4(Number(u?.u ?? 0) / a) : 0;
      }
      topics.push({
        clusterId: f.clusterId,
        label: f.label,
        kind: f.kind,
        distinctVisitors: f.distinctVisitors,
        dialogs: f.conversationIds.length,
        conversions,
        unknownShare,
        status: f.status,
      });
    }
    return {
      period: this.period(query, s.tz),
      topics,
      uncovered: topics.filter(
        (t) => t.status === 'open' && t.distinctVisitors >= 3,
      ).length,
    };
  }

  async sites(m: AccountMembership, q: StatsQuery): Promise<StatsSitesView> {
    const query = parseStatsQuery(q);
    const db = this.sitesDb.forAccount(m.accountId);
    const sites = await db.site.findMany({
      where: {},
      select: { id: true, name: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const assist = await db.assistSite.findMany({
      where: { siteId: { in: sites.map((x) => x.id) } },
      select: { siteId: true },
    });
    const withAssist = new Set(assist.map((a) => a.siteId));
    const out: StatsSitesView['sites'] = [];
    for (const site of sites) {
      if (!withAssist.has(site.id)) continue;
      const t = totals(await this.days(db, site.id, query.from, query.to));
      out.push({
        siteId: site.id,
        name: site.name,
        dialogs: t.dialogs,
        resolvedShare: t.dialogs > 0 ? round4(t.resolved / t.dialogs) : null,
        conversions: t.conversions,
        costMicroUsd: t.cost,
      });
    }
    return { sites: out };
  }
}
