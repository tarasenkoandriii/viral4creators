/**
 * Кабинет аналитики с ИИ (Э3-бис; ТЗ §5-тер.3–6, §5-тер.13, §5-тер.16):
 *   GET   /assist/sites/:id/ai/summary?from=&to=          сводка разметки и score
 *   GET   /assist/sites/:id/ai/dialogs?from=&to=&bucket=&intent=&stage=&failure=&cursor=
 *   PATCH /assist/sites/:id/conversations/:cid/label      «неверно размечено»
 *   GET   /assist/sites/:id/stats/insights?week=          находки и выводы недели
 *   PATCH /assist/sites/:id/insights/:iid                 done | dismissed | 👍👎
 *   GET   /assist/sites/:id/stats/behavior?from=&to=      поведение страниц
 * Права — контроллер (assist: manager; оператор — 403). Только таблицы
 * «Сайта» (У-23…У-25). Текст посетителя здесь не отдаётся вовсе: разметка —
 * перечни и короткие заметки модели (замаскированы), выводы — числа кода.
 * Распределения — с весом выборки (§5-тер.3: «оценки — по выборке»).
 */
import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { SitesDb } from '../../../prisma/sites-db.service';
import { ASSIST_PLANS, type AssistPlanId } from '../../assist-billing/plans';
import { readState } from '../../assist-billing/public/entitlements';
import type { AccountMembership } from '../../site-core/account/roles';
import { effectiveAnalyticsConfig } from '../analytics-config';
import { analyticsError, notFoundSite } from '../analytics-errors';
import { parseStatsQuery } from '../stats.service';
import { dayRangeUtc, siteTz, validDay } from '../site-time';
import { analyticsModel } from './ai-env';
import { AnalyticsBudget } from './analytics-budget';
import { RUN_CODE } from './insights.service';
import { FAILURE_REASONS, INTENTS, OUTCOMES, STAGES } from './label-schema';

const DIALOGS_PAGE = 50;

export interface AiPlanView {
  planId: AssistPlanId | null;
  aiAnalytics: boolean;
  leadCalibration: boolean;
  experiments: boolean;
  linkedWindowDays: number;
  behaviorViewsPerMonth: number;
}

export interface AiSummaryView {
  plan: AiPlanView;
  model: { ok: boolean; reason: 'unset' | 'unpriced' | null };
  budget: { period: string; capMicroUsd: number; spentMicroUsd: number };
  coverage: {
    closed: number;
    labeled: number;
    failed: number;
    skipped: number;
    injection: number;
    pending: number;
    /** Есть разметка по выборке (вес > 1) — «оценки — по выборке». */
    sampled: boolean;
  };
  buckets: { hot: number; warm: number; cold: number; hotNoLead: number };
  intents: Array<{ key: string; n: number }>;
  stages: Array<{ key: string; n: number }>;
  outcomes: Array<{ key: string; n: number }>;
  failureReasons: Array<{ key: string; n: number }>;
  overridden: number;
  calibration: {
    version: number;
    method: string;
    positives: number;
    total: number;
    auc: number | null;
    brier: number | null;
    ece: number | null;
    createdAt: string;
  } | null;
}

export interface AiDialogView {
  conversationId: string;
  createdAt: string;
  pagePath: string | null;
  locale: string | null;
  status: string;
  intent: string | null;
  stage: string | null;
  outcome: string | null;
  failureReason: string | null;
  buyingSignals: string[];
  leadScore: number | null;
  leadBucket: string | null;
  leadProb: number | null;
  /** Объяснение score: признаки и вклад. */
  features: Array<{ f: string; c: number }>;
  sentimentEnd: number | null;
  frustration: boolean;
  answerQuality: number | null;
  qualityFlags: string[];
  topics: string[];
  entities: string[];
  intentNote: string | null;
  failureNote: string | null;
  converted: boolean;
  lead: boolean;
  handoff: boolean;
  weight: number;
  humanOverride: Record<string, string> | null;
}

export interface InsightView {
  id: string;
  code: string;
  impact: string;
  finding: Record<string, unknown>;
  text: { title: string; what: string; action: string } | null;
  textSkipped: string | null;
  status: string;
  doneAt: string | null;
  followUp: unknown;
  feedback: number | null;
}

export interface BehaviorPageView {
  path: string;
  views: number;
  activeMsMedian: number;
  scrollMedian: number;
  deepScrollShare: number;
  backNav: number;
  rage: number;
  jsErrors: number;
  formStarts: number;
  formAbandons: number;
  topAbandonField: string | null;
  lcpP75: number | null;
  inpP75: number | null;
  clsP75: number | null;
  chatOpens: number;
}

const OVERRIDE_FIELDS: Record<string, readonly string[]> = {
  intent: INTENTS,
  stage: STAGES,
  outcome: OUTCOMES,
  failureReason: FAILURE_REASONS,
  leadBucket: ['hot', 'warm', 'cold'],
};

const PAGE_SQL = `COALESCE(NULLIF(substring(c."pageUrl" from '^https?://[^/]+(/[^?#]*)'), ''), '/')`;
/** Действующее значение поля: исправление человека сильнее модели. */
const eff = (f: string) => `COALESCE(l."humanOverride"->>'${f}', l."${f}")`;

@Injectable()
export class AiCabinetService {
  now: () => Date = () => new Date();
  env: NodeJS.ProcessEnv = process.env;

  constructor(
    private readonly sitesDb: SitesDb,
    private readonly prisma: PrismaService,
    private readonly budget: AnalyticsBudget,
  ) {}

  private async site(m: AccountMembership, siteId: string) {
    const db = this.sitesDb.forAccount(m.accountId);
    const s = await db.site.findFirst({
      where: { id: siteId },
      select: { id: true },
    });
    if (!s) throw notFoundSite();
    const a = await db.assistSite.findFirst({
      where: { siteId },
      select: { timezone: true, analytics: true },
    });
    return { db, tz: siteTz(a?.timezone), analytics: a?.analytics ?? null };
  }

  async plan(accountId: string): Promise<AiPlanView> {
    const st = await readState(this.prisma, accountId, this.now());
    const p = st.planId ? ASSIST_PLANS[st.planId] : null;
    return {
      planId: st.planId,
      aiAnalytics: !!p?.aiAnalytics,
      leadCalibration: !!p?.leadCalibration,
      experiments: !!p?.experiments,
      linkedWindowDays: p?.linkedWindowDays ?? 0,
      behaviorViewsPerMonth: p?.behaviorViewsPerMonth ?? 0,
    };
  }

  private range(q: unknown, tz: string) {
    const query = parseStatsQuery(q);
    return {
      query,
      start: dayRangeUtc(query.from, tz).start,
      end: dayRangeUtc(query.to, tz).end,
    };
  }

  async summary(
    m: AccountMembership,
    siteId: string,
    q: unknown,
  ): Promise<AiSummaryView> {
    const s = await this.site(m, siteId);
    const { start, end } = this.range(q, s.tz);
    const now = this.now();
    const p = this.prisma;
    const [cov] = await p.$queryRawUnsafe<
      Array<{
        closed: bigint;
        labeled: bigint;
        failed: bigint;
        skipped: bigint;
        injection: bigint;
        sampled: boolean;
        overridden: bigint;
      }>
    >(
      `SELECT count(*) AS closed,
              count(*) FILTER (WHERE l."status" IN ('ok', 'injection_suspect')) AS labeled,
              count(*) FILTER (WHERE l."status" = 'failed') AS failed,
              count(*) FILTER (WHERE l."status" = 'skipped') AS skipped,
              count(*) FILTER (WHERE l."status" = 'injection_suspect') AS injection,
              COALESCE(bool_or(l."weight" > 1), false) AS sampled,
              count(*) FILTER (WHERE l."humanOverride" IS NOT NULL) AS overridden
         FROM "sites"."assist_site_conversations" c
         LEFT JOIN "sites"."assist_site_conversation_labels" l ON l."conversationId" = c."id"
        WHERE c."siteId" = $1 AND c."accountId" = $2 AND c."createdAt" >= $3 AND c."createdAt" < $4
          AND NOT c."suspicious" AND c."lastMessageAt" < $5
          AND EXISTS (SELECT 1 FROM "sites"."assist_site_messages" x
                       WHERE x."conversationId" = c."id" AND x."role" = 'assistant'
                         AND x."answerPath" IN ('model', 'faq', 'cache'))`,
      siteId,
      m.accountId,
      start,
      end,
      new Date(now.getTime() - 30 * 60 * 1000),
    );
    const base = `FROM "sites"."assist_site_conversation_labels" l
        JOIN "sites"."assist_site_conversations" c ON c."id" = l."conversationId"
       WHERE l."siteId" = $1 AND l."accountId" = $2 AND c."createdAt" >= $3 AND c."createdAt" < $4
         AND l."status" IN ('ok', 'injection_suspect') AND l."weight" > 0`;
    const dist = async (field: string) =>
      (
        await p.$queryRawUnsafe<Array<{ key: string | null; n: number }>>(
          `SELECT ${eff(field)} AS key, sum(l."weight")::float8 AS n ${base}
            GROUP BY 1 ORDER BY 2 DESC`,
          siteId,
          m.accountId,
          start,
          end,
        )
      )
        .filter((r) => r.key)
        .map((r) => ({ key: r.key as string, n: Math.round(Number(r.n)) }));
    const [b] = await p.$queryRawUnsafe<
      Array<{ hot: number; warm: number; cold: number; hotNoLead: number }>
    >(
      `SELECT COALESCE(sum(l."weight") FILTER (WHERE ${eff('leadBucket')} = 'hot'), 0)::float8 AS hot,
              COALESCE(sum(l."weight") FILTER (WHERE ${eff('leadBucket')} = 'warm'), 0)::float8 AS warm,
              COALESCE(sum(l."weight") FILTER (WHERE ${eff('leadBucket')} = 'cold'), 0)::float8 AS cold,
              COALESCE(sum(l."weight") FILTER (
                WHERE ${eff('leadBucket')} = 'hot'
                  AND NOT EXISTS (SELECT 1 FROM "sites"."assist_site_leads" ld WHERE ld."conversationId" = l."conversationId")
                  AND NOT EXISTS (SELECT 1 FROM "sites"."assist_site_goal_events" e
                                   WHERE e."conversationId" = l."conversationId" AND e."status" = 'completed')), 0)::float8 AS "hotNoLead"
         ${base}`,
      siteId,
      m.accountId,
      start,
      end,
    );
    const cal = await p.assistSiteLeadCalibration.findFirst({
      where: { siteId, accountId: m.accountId },
      orderBy: { version: 'desc' },
    });
    const model = analyticsModel(this.env);
    this.budget.env = this.env;
    const closed = Number(cov?.closed ?? 0);
    const labeled = Number(cov?.labeled ?? 0);
    const failed = Number(cov?.failed ?? 0);
    const skipped = Number(cov?.skipped ?? 0);
    return {
      plan: await this.plan(m.accountId),
      model: { ok: model.ok, reason: model.ok ? null : model.reason },
      budget: await this.budget.status(m.accountId, siteId, now),
      coverage: {
        closed,
        labeled,
        failed,
        skipped,
        injection: Number(cov?.injection ?? 0),
        pending: Math.max(0, closed - labeled - failed - skipped),
        sampled: !!cov?.sampled,
      },
      buckets: {
        hot: Math.round(Number(b?.hot ?? 0)),
        warm: Math.round(Number(b?.warm ?? 0)),
        cold: Math.round(Number(b?.cold ?? 0)),
        hotNoLead: Math.round(Number(b?.hotNoLead ?? 0)),
      },
      intents: await dist('intent'),
      stages: await dist('stage'),
      outcomes: await dist('outcome'),
      failureReasons: await dist('failureReason'),
      overridden: Number(cov?.overridden ?? 0),
      calibration: cal
        ? {
            version: cal.version,
            method: cal.method,
            positives: cal.positives,
            total: cal.total,
            auc: cal.auc,
            brier: cal.brier,
            ece: cal.ece,
            createdAt: cal.createdAt.toISOString(),
          }
        : null,
    };
  }

  async dialogs(
    m: AccountMembership,
    siteId: string,
    q: Record<string, unknown>,
  ): Promise<{ items: AiDialogView[]; nextCursor: string | null }> {
    const s = await this.site(m, siteId);
    const { start, end } = this.range(q, s.tz);
    const filters: string[] = [];
    const args: unknown[] = [siteId, m.accountId, start, end];
    const add = (field: string, list: readonly string[], v: unknown) => {
      if (v === undefined || v === '') return;
      if (typeof v !== 'string' || !list.includes(v)) {
        throw analyticsError(
          HttpStatus.BAD_REQUEST,
          'BAD_REQUEST',
          `Фильтр ${field}`,
        );
      }
      args.push(v);
      filters.push(`${eff(field)} = $${args.length}`);
    };
    add('leadBucket', ['hot', 'warm', 'cold'], q.bucket);
    add('intent', INTENTS, q.intent);
    add('stage', STAGES, q.stage);
    add('failureReason', FAILURE_REASONS, q.failure);
    if (q.cursor !== undefined) {
      const t = typeof q.cursor === 'string' ? Date.parse(q.cursor) : NaN;
      if (!Number.isFinite(t)) {
        throw analyticsError(HttpStatus.BAD_REQUEST, 'BAD_REQUEST', 'cursor');
      }
      args.push(new Date(t));
      filters.push(`c."createdAt" < $${args.length}`);
    }
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{
        conversationId: string;
        createdAt: Date;
        page: string;
        locale: string | null;
        status: string;
        intent: string | null;
        stage: string | null;
        outcome: string | null;
        failureReason: string | null;
        leadBucket: string | null;
        buyingSignals: string[];
        leadScore: number | null;
        leadProb: number | null;
        leadFeatures: unknown;
        sentimentEnd: number | null;
        frustration: boolean;
        answerQuality: number | null;
        qualityFlags: string[];
        topics: string[];
        entities: string[];
        intentNote: string | null;
        failureNote: string | null;
        weight: number;
        humanOverride: unknown;
        converted: boolean;
        lead: boolean;
        handoff: boolean;
      }>
    >(
      `SELECT l."conversationId", c."createdAt", ${PAGE_SQL} AS page, c."locale", l."status",
              ${eff('intent')} AS intent, ${eff('stage')} AS stage, ${eff('outcome')} AS outcome,
              ${eff('failureReason')} AS "failureReason", ${eff('leadBucket')} AS "leadBucket",
              l."buyingSignals", l."leadScore", l."leadProb", l."leadFeatures", l."sentimentEnd",
              l."frustration", l."answerQuality", l."qualityFlags", l."topics", l."entities",
              l."intentNote", l."failureNote", l."weight", l."humanOverride",
              EXISTS (SELECT 1 FROM "sites"."assist_site_goal_events" e
                       WHERE e."conversationId" = c."id" AND e."status" = 'completed'
                         AND e."attribution" IN ('direct', 'assisted')) AS converted,
              EXISTS (SELECT 1 FROM "sites"."assist_site_leads" ld WHERE ld."conversationId" = c."id") AS lead,
              EXISTS (SELECT 1 FROM "sites"."assist_site_handoffs" h
                       WHERE h."conversationId" = c."id" AND h."state" <> 'cancelled') AS handoff
         FROM "sites"."assist_site_conversation_labels" l
         JOIN "sites"."assist_site_conversations" c ON c."id" = l."conversationId"
        WHERE l."siteId" = $1 AND l."accountId" = $2 AND c."createdAt" >= $3 AND c."createdAt" < $4
          AND l."status" <> 'skipped'
          ${filters.length ? `AND ${filters.join(' AND ')}` : ''}
        ORDER BY c."createdAt" DESC LIMIT ${DIALOGS_PAGE + 1}`,
      ...args,
    );
    const items = rows.slice(0, DIALOGS_PAGE).map((r): AiDialogView => ({
      conversationId: r.conversationId,
      createdAt: r.createdAt.toISOString(),
      pagePath: r.page,
      locale: r.locale,
      status: r.status,
      intent: r.intent,
      stage: r.stage,
      outcome: r.outcome,
      failureReason: r.failureReason,
      buyingSignals: r.buyingSignals ?? [],
      leadScore: r.leadScore,
      leadBucket: r.leadBucket,
      leadProb: r.leadProb,
      features: Array.isArray(r.leadFeatures)
        ? (r.leadFeatures as Array<{ f: string; c: number }>)
        : [],
      sentimentEnd: r.sentimentEnd,
      frustration: r.frustration,
      answerQuality: r.answerQuality,
      qualityFlags: r.qualityFlags ?? [],
      topics: r.topics ?? [],
      entities: r.entities ?? [],
      intentNote: r.intentNote,
      failureNote: r.failureNote,
      converted: r.converted,
      lead: r.lead,
      handoff: r.handoff,
      weight: Number(r.weight),
      humanOverride:
        r.humanOverride && typeof r.humanOverride === 'object'
          ? (r.humanOverride as Record<string, string>)
          : null,
    }));
    return {
      items,
      nextCursor:
        rows.length > DIALOGS_PAGE ? items[items.length - 1].createdAt : null,
    };
  }

  /** «Неверно размечено» (§5-тер.16): поверх модели, повторная разметка не затирает. */
  async overrideLabel(
    m: AccountMembership,
    siteId: string,
    conversationId: string,
    body: unknown,
  ): Promise<{ ok: true; humanOverride: Record<string, string> | null }> {
    const s = await this.site(m, siteId);
    const b =
      body && typeof body === 'object' && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : null;
    const errors: Array<{ path: string; code: string }> = [];
    if (!b) errors.push({ path: '', code: 'type' });
    const patch: Record<string, string | null> = {};
    for (const [k, v] of Object.entries(b ?? {})) {
      const list = OVERRIDE_FIELDS[k];
      if (!list) errors.push({ path: k, code: 'unknown' });
      else if (v === null) patch[k] = null;
      else if (typeof v !== 'string' || !list.includes(v))
        errors.push({ path: k, code: 'enum' });
      else patch[k] = v;
    }
    if (errors.length || !Object.keys(patch).length) {
      throw analyticsError(
        HttpStatus.BAD_REQUEST,
        'LABEL_INVALID',
        'Проверьте исправление разметки',
        {
          errors: errors.length ? errors : [{ path: '', code: 'empty' }],
        },
      );
    }
    const row = await s.db.assistSiteConversationLabel.findFirst({
      where: { conversationId, siteId },
      select: { humanOverride: true },
    });
    if (!row) {
      throw analyticsError(
        HttpStatus.NOT_FOUND,
        'LABEL_NOT_FOUND',
        'Диалог ещё не размечен',
      );
    }
    const cur = (
      row.humanOverride && typeof row.humanOverride === 'object'
        ? row.humanOverride
        : {}
    ) as Record<string, string>;
    const next: Record<string, string> = { ...cur };
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) delete next[k];
      else next[k] = v;
    }
    const empty = !Object.keys(next).length;
    await s.db.assistSiteConversationLabel.updateMany({
      where: { conversationId, siteId },
      data: {
        humanOverride: empty ? Prisma.DbNull : (next as Prisma.InputJsonValue),
        overriddenBy: empty ? null : String(m.telegramId),
        overriddenAt: empty ? null : this.now(),
      },
    });
    return { ok: true, humanOverride: empty ? null : next };
  }

  async insights(
    m: AccountMembership,
    siteId: string,
    week: unknown,
  ): Promise<{
    weeks: string[];
    weekStart: string | null;
    items: InsightView[];
    plan: AiPlanView;
    model: { ok: boolean; reason: string | null };
  }> {
    const s = await this.site(m, siteId);
    if (week !== undefined && !validDay(week)) {
      throw analyticsError(
        HttpStatus.BAD_REQUEST,
        'STATS_RANGE_INVALID',
        'week — YYYY-MM-DD',
      );
    }
    const weeks = (
      await s.db.assistSiteInsight.findMany({
        where: { siteId, code: RUN_CODE },
        orderBy: { weekStart: 'desc' },
        select: { weekStart: true },
        take: 12,
      })
    ).map((w) => w.weekStart);
    const weekStart = (week as string | undefined) ?? weeks[0] ?? null;
    const rows = weekStart
      ? await s.db.assistSiteInsight.findMany({
          where: { siteId, weekStart, code: { not: RUN_CODE } },
          orderBy: [{ createdAt: 'asc' }],
        })
      : [];
    const rank: Record<string, number> = { high: 0, medium: 1, low: 2 };
    const model = analyticsModel(this.env);
    return {
      weeks,
      weekStart,
      items: rows
        .sort((a, b) => (rank[a.impact] ?? 3) - (rank[b.impact] ?? 3))
        .map((r) => ({
          id: r.id,
          code: r.code,
          impact: r.impact,
          finding: r.finding as Record<string, unknown>,
          text: (r.text as InsightView['text']) ?? null,
          textSkipped: r.textSkipped,
          status: r.status,
          doneAt: r.doneAt ? r.doneAt.toISOString() : null,
          followUp: r.followUp ?? null,
          feedback: r.feedback,
        })),
      plan: await this.plan(m.accountId),
      model: { ok: model.ok, reason: model.ok ? null : model.reason },
    };
  }

  async patchInsight(
    m: AccountMembership,
    siteId: string,
    id: string,
    body: unknown,
  ): Promise<{ ok: true }> {
    const s = await this.site(m, siteId);
    const b =
      body && typeof body === 'object' && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : {};
    const data: Prisma.AssistSiteInsightUpdateManyMutationInput = {};
    const errors: Array<{ path: string; code: string }> = [];
    for (const k of Object.keys(b)) {
      if (!['status', 'feedback'].includes(k))
        errors.push({ path: k, code: 'unknown' });
    }
    if (b.status !== undefined) {
      if (!['new', 'done', 'dismissed'].includes(b.status as string)) {
        errors.push({ path: 'status', code: 'enum' });
      } else {
        data.status = b.status as string;
        data.doneAt = b.status === 'done' ? this.now() : null;
        if (b.status !== 'done') data.followUp = Prisma.DbNull;
      }
    }
    if (b.feedback !== undefined) {
      if (![1, -1, 0].includes(b.feedback as number))
        errors.push({ path: 'feedback', code: 'enum' });
      else data.feedback = b.feedback === 0 ? null : (b.feedback as number);
    }
    if (errors.length || !Object.keys(data).length) {
      throw analyticsError(
        HttpStatus.BAD_REQUEST,
        'INSIGHT_INVALID',
        'Проверьте отметку вывода',
        {
          errors: errors.length ? errors : [{ path: '', code: 'empty' }],
        },
      );
    }
    const n = await s.db.assistSiteInsight.updateMany({
      where: { id, siteId, code: { not: RUN_CODE } },
      data,
    });
    if (n.count !== 1) {
      throw analyticsError(
        HttpStatus.NOT_FOUND,
        'INSIGHT_NOT_FOUND',
        'Нет такого вывода',
      );
    }
    return { ok: true };
  }

  async behavior(
    m: AccountMembership,
    siteId: string,
    q: unknown,
  ): Promise<{
    enabled: boolean;
    reason: 'plan' | 'settings' | null;
    quota: { used: number; limit: number };
    pages: BehaviorPageView[];
    totalViews: number;
  }> {
    const s = await this.site(m, siteId);
    const query = parseStatsQuery(q);
    const plan = await this.plan(m.accountId);
    const cfg = effectiveAnalyticsConfig(s.analytics);
    const now = this.now();
    const [u] = await this.prisma.$queryRawUnsafe<Array<{ n: bigint | null }>>(
      `SELECT sum(ec."count") AS n FROM "sites"."assist_site_event_counts" ec
         JOIN "sites"."assist_sites" a ON a."siteId" = ec."siteId"
        WHERE a."accountId" = $1 AND ec."kind" = 'bf_pv' AND ec."day" >= $2`,
      m.accountId,
      `${now.toISOString().slice(0, 7)}-01`,
    );
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{
        path: string;
        views: number;
        am: number | null;
        sm: number | null;
        deep: number;
        back: number;
        rage: number;
        errs: number;
        fs: number;
        fa: number;
        fields: unknown;
        lcp: number | null;
        inp: number | null;
        cls: number | null;
        chat: number;
      }>
    >(
      `SELECT "path", sum("views")::int AS views,
              (sum("activeMsMedian" * "views") / NULLIF(sum("views"), 0))::float8 AS am,
              (sum("scrollMedian" * "views") / NULLIF(sum("views"), 0))::float8 AS sm,
              sum("deepScroll")::int AS deep, sum("backNav")::int AS back, sum("rage")::int AS rage,
              sum("jsErrors")::int AS errs, sum("formStarts")::int AS fs, sum("formAbandons")::int AS fa,
              jsonb_agg("abandonFields") AS fields,
              (sum("lcpP75" * "views") FILTER (WHERE "lcpP75" IS NOT NULL)
                 / NULLIF(sum("views") FILTER (WHERE "lcpP75" IS NOT NULL), 0))::float8 AS lcp,
              (sum("inpP75" * "views") FILTER (WHERE "inpP75" IS NOT NULL)
                 / NULLIF(sum("views") FILTER (WHERE "inpP75" IS NOT NULL), 0))::float8 AS inp,
              (sum("clsP75" * "views") FILTER (WHERE "clsP75" IS NOT NULL)
                 / NULLIF(sum("views") FILTER (WHERE "clsP75" IS NOT NULL), 0))::float8 AS cls,
              sum("chatOpens")::int AS chat
         FROM "sites"."assist_site_daily_pages"
        WHERE "siteId" = $1 AND "accountId" = $2 AND "day" >= $3 AND "day" <= $4
        GROUP BY "path" ORDER BY 2 DESC LIMIT 100`,
      siteId,
      m.accountId,
      query.from,
      query.to,
    );
    const top = (v: unknown): string | null => {
      const acc: Record<string, number> = {};
      for (const o of Array.isArray(v) ? v : []) {
        if (o && typeof o === 'object') {
          for (const [k, n] of Object.entries(o as Record<string, unknown>)) {
            acc[k] = (acc[k] ?? 0) + (Number(n) || 0);
          }
        }
      }
      return Object.entries(acc).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    };
    const pages = rows.map((r) => ({
      path: r.path,
      views: Number(r.views),
      activeMsMedian: Math.round(Number(r.am ?? 0)),
      scrollMedian: Math.round(Number(r.sm ?? 0)),
      deepScrollShare:
        r.views > 0
          ? Math.round((Number(r.deep) / Number(r.views)) * 1000) / 1000
          : 0,
      backNav: Number(r.back),
      rage: Number(r.rage),
      jsErrors: Number(r.errs),
      formStarts: Number(r.fs),
      formAbandons: Number(r.fa),
      topAbandonField: top(r.fields),
      lcpP75: r.lcp === null ? null : Math.round(Number(r.lcp)),
      inpP75: r.inp === null ? null : Math.round(Number(r.inp)),
      clsP75: r.cls === null ? null : Math.round(Number(r.cls) * 1000) / 1000,
      chatOpens: Number(r.chat),
    }));
    const enabled =
      plan.behaviorViewsPerMonth > 0 && cfg.behavior && cfg.linked;
    return {
      enabled,
      reason:
        plan.behaviorViewsPerMonth <= 0 ? 'plan' : enabled ? null : 'settings',
      quota: { used: Number(u?.n ?? 0), limit: plan.behaviorViewsPerMonth },
      pages,
      totalViews: pages.reduce((sum, p) => sum + p.views, 0),
    };
  }
}
