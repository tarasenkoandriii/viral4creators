/**
 * Недельная работа по сайту — находки, выводы модели, «Сделано» → до/после,
 * калибровка lead score (Э3-бис; ТЗ §5-тер.4–5, Р-44, Р-45). Системный код
 * крона `assist-analytics-run` (без нового крона, Vercel Hobby): за тик —
 * несколько сайтов, у которых прошедшая неделя (пн–вс в поясе сайта) ещё
 * не обработана; отметка «обработано» — строка `code = 'RUN'` той же
 * таблицы (её не видят экраны и отчёт).
 *
 * Модель — один вызов на сайт в неделю, только Business+ (`aiAnalytics`),
 * lite-модель `ASSIST_LITE_MODEL`, резерв бюджета аналитики ДО вызова; вход
 * — находки (числа кода) и ≤ 5 замаскированных примеров вопросов; каждый
 * вывод проходит проверку чисел и путей (`parseInsights`), не прошёл —
 * находка остаётся сухой строкой (`textSkipped = 'numbers' | 'links'`).
 * Start/Trial — находки кодом без модели (сухие строки, §5-тер.17).
 */
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { estimateCost } from '../../../shared/ai-pricing';
import type { CronScope } from '../../../common/cron-scope';
import { ASSIST_PLANS } from '../../assist-billing/plans';
import { readState } from '../../assist-billing/public/entitlements';
import { maskForJournal } from '../../assist-site-chat/answer-checks';
import { GeminiText, TextModelError } from '../../site-ai/text-model';
import { AiUsageRecorder } from '../../site-ai/usage-recorder';
import { effectiveAnalyticsConfig } from '../analytics-config';
import {
  addDays,
  dayInTz,
  dayRangeUtc,
  isoWeekdayInTz,
  siteTz,
} from '../site-time';
import { normalizePath } from '../public/page-view';
import { analyticsModel } from './ai-env';
import { AnalyticsBudget } from './analytics-budget';
import {
  buildInsightPrompt,
  detectFindings,
  metricFor,
  parseInsights,
  type Finding,
  type FindingInputs,
} from './findings';
import {
  CALIBRATION_MIN_POSITIVES,
  CALIBRATION_MIN_TOTAL,
  auc,
  brier,
  ece,
  fitPlatt,
  plattProb,
} from './lead-score';

const DAY = 24 * 60 * 60 * 1000;
export const RUN_CODE = 'RUN';
export const FOLLOW_UP_DAYS = 14;
const INSIGHT_MAX_OUTPUT = 1200;

export interface WeeklyTickResult {
  sites: number;
  findings: number;
  texts: number;
  rejected: number;
  calibrated: number;
  followUps: number;
}

/** Понедельник прошедшей (полной) недели в поясе сайта. */
export function lastWeekStart(now: Date, tz: string): string {
  const today = dayInTz(now, tz);
  const monday = addDays(today, -(isoWeekdayInTz(now, tz) - 1));
  return addDays(monday, -7);
}

/** Путь из URL диалога (SQL-выражение повторено в запросах ниже). */
const PAGE_SQL = `COALESCE(NULLIF(substring(c."pageUrl" from '^https?://[^/]+(/[^?#]*)'), ''), '/')`;

/** Ключ страницы находки: null (итог по сайту) → `*`, иначе нормализованный путь. */
export function pageKey(page: string | null): string {
  if (page === null) return '*';
  return normalizePath(page) ?? '/';
}

@Injectable()
export class WeeklyInsights {
  private readonly logger = new Logger(WeeklyInsights.name);
  env: NodeJS.ProcessEnv = process.env;
  now: () => Date = () => new Date();

  constructor(
    private readonly prisma: PrismaService,
    private readonly text: GeminiText,
    private readonly usage: AiUsageRecorder,
    private readonly budget: AnalyticsBudget,
  ) {}

  async tick(opts: {
    now?: Date;
    deadline: number;
    maxSites: number;
    scope?: CronScope;
  }): Promise<WeeklyTickResult> {
    const now = opts.now ?? this.now();
    const res: WeeklyTickResult = {
      sites: 0,
      findings: 0,
      texts: 0,
      rejected: 0,
      calibrated: 0,
      followUps: 0,
    };
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{ siteId: string; accountId: string; timezone: string }>
    >(
      `SELECT a."siteId", a."accountId", a."timezone" FROM "sites"."assist_sites" a
        WHERE a."widgetVersion" > 0
          AND ($1::text[] IS NULL OR a."siteId" = ANY($1::text[]))
        ORDER BY a."siteId" LIMIT 2000`,
      opts.scope ? opts.scope.siteIds : null,
    );
    if (!rows.length) return res;
    const done = await this.prisma.$queryRawUnsafe<
      Array<{ siteId: string; weekStart: string }>
    >(
      `SELECT "siteId", "weekStart" FROM "sites"."assist_site_insights"
        WHERE "code" = $1 AND "siteId" = ANY($2::text[]) AND "weekStart" >= $3`,
      RUN_CODE,
      rows.map((r) => r.siteId),
      addDays(now.toISOString().slice(0, 10), -15),
    );
    const seen = new Set(done.map((d) => `${d.siteId}:${d.weekStart}`));
    for (const r of rows) {
      if (res.sites >= opts.maxSites || Date.now() > opts.deadline) break;
      const week = lastWeekStart(now, siteTz(r.timezone));
      if (seen.has(`${r.siteId}:${week}`)) continue;
      try {
        const one = await this.runSite(r.accountId, r.siteId, week, now);
        res.sites++;
        res.findings += one.findings;
        res.texts += one.texts;
        res.rejected += one.rejected;
        res.calibrated += one.calibrated ? 1 : 0;
        res.followUps += one.followUps;
      } catch (e) {
        this.logger.warn(
          `неделя ${r.siteId}: ${(e as Error | null)?.name ?? 'Error'}`,
        );
      }
    }
    return res;
  }

  /** Неделя сайта целиком (тесты зовут напрямую). */
  async runSite(
    accountId: string,
    siteId: string,
    weekStart: string,
    now: Date,
  ): Promise<{
    findings: number;
    texts: number;
    rejected: number;
    calibrated: boolean;
    followUps: number;
    skipped: string | null;
  }> {
    const out = {
      findings: 0,
      texts: 0,
      rejected: 0,
      calibrated: false,
      followUps: 0,
      skipped: null as string | null,
    };
    const state = await readState(this.prisma, accountId, now);
    const plan = state.planId ? ASSIST_PLANS[state.planId] : null;
    const site = await this.prisma.assistSite.findUnique({
      where: { siteId },
      select: { timezone: true, analytics: true, siteSummary: true },
    });
    const meta = await this.prisma.site.findUnique({
      where: { id: siteId },
      select: { name: true },
    });
    if (!site || !meta) return out;
    if (!plan) {
      out.skipped = 'plan';
      await this.mark(accountId, siteId, weekStart, { skipped: 'plan' });
      return out;
    }
    const tz = siteTz(site.timezone);
    if (plan.leadCalibration) {
      out.calibrated = await this.calibrate(
        accountId,
        siteId,
        site.analytics,
        now,
      );
    }
    out.followUps = await this.followUps(accountId, siteId, tz, now);

    const inputs = await this.inputs(
      accountId,
      siteId,
      tz,
      weekStart,
      addDays(weekStart, 6),
    );
    const findings = detectFindings(inputs);
    await this.examples(accountId, siteId, tz, weekStart, findings);
    out.findings = findings.length;

    const texts = new Map<
      number,
      { title: string; what: string; action: string }
    >();
    const rejected = new Map<number, string>();
    let skipped: string | null = null;
    let model: string | null = null;
    let cost = 0;
    if (!findings.length) {
      skipped = null;
    } else if (!plan.aiAnalytics) {
      skipped = 'plan';
    } else {
      const m = analyticsModel(this.env);
      if (!m.ok) skipped = 'model';
      else {
        model = m.model;
        const r = await this.modelTexts(
          accountId,
          siteId,
          meta.name,
          site.siteSummary,
          findings,
          m.model,
          now,
        );
        skipped = r.skipped;
        cost = r.cost;
        for (const [i, t] of r.texts) texts.set(i, t);
        for (const [i, c] of r.rejected) rejected.set(i, c);
      }
    }
    for (let i = 0; i < findings.length; i++) {
      const f = findings[i];
      const t = texts.get(i) ?? null;
      const { examples: _ex, ...stored } = f;
      await this.prisma.assistSiteInsight.upsert({
        where: {
          siteId_weekStart_findingKey: {
            siteId,
            weekStart,
            findingKey: f.key,
          },
        },
        create: {
          accountId,
          siteId,
          weekStart,
          code: f.code,
          findingKey: f.key,
          finding: stored as unknown as Prisma.InputJsonValue,
          impact: f.impact,
          text: t ? (t as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
          textSkipped: t ? null : (rejected.get(i) ?? skipped),
          model: t ? model : null,
          costMicroUsd: i === 0 ? cost : 0,
        },
        update: {},
      });
      if (t) out.texts++;
    }
    out.rejected = rejected.size;
    await this.mark(accountId, siteId, weekStart, {
      findings: findings.length,
      texts: out.texts,
      rejected: out.rejected,
      skipped,
    });
    return out;
  }

  private async mark(
    accountId: string,
    siteId: string,
    weekStart: string,
    info: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.assistSiteInsight.upsert({
      where: {
        siteId_weekStart_findingKey: {
          siteId,
          weekStart,
          findingKey: RUN_CODE,
        },
      },
      create: {
        accountId,
        siteId,
        weekStart,
        code: RUN_CODE,
        findingKey: RUN_CODE,
        finding: info as Prisma.InputJsonValue,
        impact: 'low',
        status: 'meta',
      },
      update: { finding: info as Prisma.InputJsonValue },
    });
  }

  private async modelTexts(
    accountId: string,
    siteId: string,
    siteName: string,
    summary: unknown,
    findings: Finding[],
    model: string,
    now: Date,
  ): Promise<{
    texts: Map<number, { title: string; what: string; action: string }>;
    rejected: Map<number, string>;
    skipped: string | null;
    cost: number;
  }> {
    const texts = new Map<
      number,
      { title: string; what: string; action: string }
    >();
    const rejected = new Map<number, string>();
    const niche =
      summary &&
      typeof summary === 'object' &&
      typeof (summary as { businessType?: unknown }).businessType === 'string'
        ? (summary as { businessType: string }).businessType.slice(0, 80)
        : null;
    // Язык кабинета — русский, как отчёт недели (report-text.ts; паритет uk/en — вопрос владельцу).
    const prompt = buildInsightPrompt({
      findings,
      siteName,
      niche,
      lang: 'ru',
    });
    const est = estimateCost(
      model,
      {
        inputTokens: Math.ceil((prompt.system.length + prompt.user.length) / 2),
        outputTokens: INSIGHT_MAX_OUTPUT,
      },
      this.env,
    ).costMicroUsd;
    this.budget.env = this.env;
    const cap = await this.budget.siteCap(accountId, siteId, now);
    const rsv = await this.budget.reserve(accountId, siteId, est, cap, now);
    if (rsv.result !== 'ok' || !rsv.reservation) {
      return { texts, rejected, skipped: 'budget', cost: 0 };
    }
    let cost = 0;
    let settled = false;
    try {
      const out = await this.text.generate({
        system: prompt.system,
        user: prompt.user,
        json: true,
        temperature: 0.2,
        maxOutputTokens: INSIGHT_MAX_OUTPUT,
        model,
      });
      const rec = await this.usage.record(this.prisma, {
        accountId,
        siteId,
        operation: 'assist-insight',
        model: out.model,
        units: {
          inputTokens: out.inputTokens,
          cachedInputTokens: out.cachedInputTokens,
          outputTokens: out.outputTokens,
        },
      });
      cost = rec.costMicroUsd;
      settled = true;
      await this.budget.settle(rsv.reservation, cost);
      const parsed = parseInsights(out.text, findings);
      if (parsed.invalid) return { texts, rejected, skipped: 'model', cost };
      for (const a of parsed.accepted) {
        for (const i of a.findingIndexes)
          if (!texts.has(i)) texts.set(i, a.text);
      }
      for (const r of parsed.rejected) {
        for (const i of r.findingIndexes)
          if (!texts.has(i)) rejected.set(i, r.code);
      }
      for (const i of texts.keys()) rejected.delete(i);
      if (parsed.rejected.length) {
        this.logger.warn(
          `выводы ${siteId}: отброшено проверкой ${parsed.rejected.length} (${parsed.rejected.map((r) => r.code).join(',')})`,
        );
      }
      return { texts, rejected, skipped: null, cost };
    } catch (e) {
      if (e instanceof TextModelError) {
        if (!settled) await this.budget.settle(rsv.reservation, 0);
        return { texts, rejected, skipped: 'model', cost };
      }
      // Иной сбой после вызова: резерв остаётся расходом (аудит Э3-бис).
      throw e;
    }
  }

  // ── входы детекторов (SQL по агрегатам и разметке) ───────────────────

  async inputs(
    accountId: string,
    siteId: string,
    tz: string,
    fromDay: string,
    toDay: string,
  ): Promise<FindingInputs> {
    const start = dayRangeUtc(fromDay, tz).start;
    const end = dayRangeUtc(toDay, tz).end;
    const p = this.prisma;
    const labeled = `
      SELECT l."conversationId", l."failureReason" AS reason, l."weight" AS w, l."topics",
             ${PAGE_SQL} AS page,
             EXISTS (SELECT 1 FROM "sites"."assist_site_goal_events" e
                      WHERE e."conversationId" = l."conversationId" AND e."status" = 'completed'
                        AND e."attribution" IN ('direct', 'assisted')) AS conv
        FROM "sites"."assist_site_conversation_labels" l
        JOIN "sites"."assist_site_conversations" c ON c."id" = l."conversationId"
       WHERE l."siteId" = $1 AND l."accountId" = $2
         AND c."createdAt" >= $3 AND c."createdAt" < $4
         AND l."status" IN ('ok', 'injection_suspect') AND l."weight" > 0`;
    const [tot] = await p.$queryRawUnsafe<Array<{ n: number | null }>>(
      `SELECT sum(w)::float8 AS n FROM (${labeled}) d`,
      siteId,
      accountId,
      start,
      end,
    );
    const fails = await p.$queryRawUnsafe<
      Array<{ page: string; reason: string | null; x: number }>
    >(
      `SELECT page, reason, sum(w)::float8 AS x FROM (${labeled}) d WHERE NOT conv
        GROUP BY GROUPING SETS ((page, reason), (reason)) `,
      siteId,
      accountId,
      start,
      end,
    );
    const failTotals = await p.$queryRawUnsafe<
      Array<{ page: string | null; n: number }>
    >(
      `SELECT page, sum(w)::float8 AS n FROM (${labeled}) d WHERE NOT conv
        GROUP BY GROUPING SETS ((page), ())`,
      siteId,
      accountId,
      start,
      end,
    );
    // Путь диалога хранится как есть — в находки (и во вход модели) идёт
    // нормализованный: номера/e-mail/телефон в пути → `:id` (аудит Э3-бис);
    // строки с одним нормализованным путём складываются.
    const nOf = new Map<string, number>();
    for (const r of failTotals) {
      const k = pageKey(r.page);
      nOf.set(k, (nOf.get(k) ?? 0) + Number(r.n));
    }
    const failAgg = new Map<
      string,
      { page: string; reason: string; x: number }
    >();
    for (const r of fails) {
      if (!r.reason) continue;
      const page = pageKey(r.page);
      const k = `${page}\u0000${r.reason}`;
      const cur = failAgg.get(k) ?? { page, reason: r.reason, x: 0 };
      cur.x += Number(r.x);
      failAgg.set(k, cur);
    }
    const failures = [...failAgg.values()].map((r) => ({
      page: r.page,
      reason: r.reason,
      x: Math.round(r.x),
      n: Math.round(nOf.get(r.page) ?? 0),
    }));
    const topics = await p.$queryRawUnsafe<
      Array<{ topic: string; conv: number; alln: number }>
    >(
      `SELECT t AS topic, sum(w) FILTER (WHERE conv)::float8 AS conv, sum(w)::float8 AS alln
         FROM (${labeled}) d, unnest(d."topics") AS t GROUP BY t`,
      siteId,
      accountId,
      start,
      end,
    );
    const [convTot] = await p.$queryRawUnsafe<
      Array<{ conv: number | null; alln: number | null }>
    >(
      `SELECT sum(w) FILTER (WHERE conv)::float8 AS conv, sum(w)::float8 AS alln FROM (${labeled}) d`,
      siteId,
      accountId,
      start,
      end,
    );
    const clusters = await p.$queryRawUnsafe<
      Array<{ label: string; visitors: number }>
    >(
      `SELECT "label", "distinctVisitors" AS visitors FROM "sites"."assist_site_learning_clusters"
        WHERE "siteId" = $1 AND "accountId" = $2 AND "kind" = 'unknown' AND "status" = 'open'
          AND "lastSeenAt" >= $3 AND "lastSeenAt" < $4
        ORDER BY "distinctVisitors" DESC LIMIT 20`,
      siteId,
      accountId,
      start,
      end,
    );
    const pages = await p.$queryRawUnsafe<
      Array<{
        path: string;
        views: number;
        rage: number;
        jsErrors: number;
        formStarts: number;
        formAbandons: number;
        fields: unknown;
        lcp: number | null;
        inp: number | null;
        cls: number | null;
      }>
    >(
      `SELECT "path", sum("views")::int AS views, sum("rage")::int AS rage,
              sum("jsErrors")::int AS "jsErrors", sum("formStarts")::int AS "formStarts",
              sum("formAbandons")::int AS "formAbandons",
              jsonb_agg("abandonFields") AS fields,
              (sum("lcpP75" * "views") FILTER (WHERE "lcpP75" IS NOT NULL)
                 / NULLIF(sum("views") FILTER (WHERE "lcpP75" IS NOT NULL), 0))::float8 AS lcp,
              (sum("inpP75" * "views") FILTER (WHERE "inpP75" IS NOT NULL)
                 / NULLIF(sum("views") FILTER (WHERE "inpP75" IS NOT NULL), 0))::float8 AS inp,
              (sum("clsP75" * "views") FILTER (WHERE "clsP75" IS NOT NULL)
                 / NULLIF(sum("views") FILTER (WHERE "clsP75" IS NOT NULL), 0))::float8 AS cls
         FROM "sites"."assist_site_daily_pages"
        WHERE "siteId" = $1 AND "accountId" = $2 AND "day" >= $3 AND "day" <= $4
        GROUP BY "path"`,
      siteId,
      accountId,
      fromDay,
      toDay,
    );
    const pro = await p.$queryRawUnsafe<Array<{ proactive: unknown }>>(
      `SELECT "proactive" FROM "sites"."assist_site_daily_totals"
        WHERE "siteId" = $1 AND "accountId" = $2 AND "group" = 'all' AND "day" >= $3 AND "day" <= $4`,
      siteId,
      accountId,
      fromDay,
      toDay,
    );
    const proactive = new Map<string, { shown: number; dismissed: number }>();
    for (const r of pro) {
      const o = (
        r.proactive && typeof r.proactive === 'object' ? r.proactive : {}
      ) as Record<string, { shown?: number; dismissed?: number }>;
      for (const [k, v] of Object.entries(o)) {
        const t = proactive.get(k) ?? { shown: 0, dismissed: 0 };
        t.shown += Number(v?.shown ?? 0);
        t.dismissed += Number(v?.dismissed ?? 0);
        proactive.set(k, t);
      }
    }
    const mergeFields = (v: unknown): Record<string, number> => {
      const out: Record<string, number> = {};
      for (const o of Array.isArray(v) ? v : []) {
        if (!o || typeof o !== 'object') continue;
        for (const [k, n] of Object.entries(o as Record<string, unknown>)) {
          out[k] = (out[k] ?? 0) + (Number(n) || 0);
        }
      }
      return out;
    };
    const pageRows = pages.map((r) => ({
      path: r.path,
      views: Number(r.views),
      rage: Number(r.rage),
      jsErrors: Number(r.jsErrors),
      formStarts: Number(r.formStarts),
      formAbandons: Number(r.formAbandons),
      abandonFields: mergeFields(r.fields),
      lcpP75: r.lcp === null ? null : Math.round(Number(r.lcp)),
      inpP75: r.inp === null ? null : Math.round(Number(r.inp)),
      clsP75: r.cls === null ? null : Math.round(Number(r.cls) * 1000) / 1000,
    }));
    return {
      labeledDialogs: Math.round(Number(tot?.n ?? 0)),
      failures,
      topics: topics.map((t) => ({
        topic: t.topic,
        conv: Math.round(Number(t.conv ?? 0)),
        convTotal: Math.round(Number(convTot?.conv ?? 0)),
        all: Math.round(Number(t.alln ?? 0)),
        allTotal: Math.round(Number(convTot?.alln ?? 0)),
      })),
      unknownClusters: clusters.map((c) => ({
        label: maskForJournal(c.label).slice(0, 120),
        visitors: Number(c.visitors),
      })),
      pages: pageRows.filter((r) => r.path !== '*'),
      totalViews: pageRows.reduce((s, r) => s + r.views, 0),
      proactive: [...proactive.entries()].map(([trigger, v]) => ({
        trigger,
        ...v,
      })),
    };
  }

  /** ≤ 5 замаскированных вопросов на находку N3 (вход модели, не UI). */
  private async examples(
    accountId: string,
    siteId: string,
    tz: string,
    weekStart: string,
    findings: Finding[],
  ): Promise<void> {
    const start = dayRangeUtc(weekStart, tz).start;
    const end = dayRangeUtc(addDays(weekStart, 6), tz).end;
    for (const f of findings) {
      if (f.code !== 'N3' || !f.reason) continue;
      // Страница находки — нормализованный путь (pageKey): сверка в коде.
      const rows = await this.prisma.$queryRawUnsafe<
        Array<{ text: string | null; page: string }>
      >(
        `SELECT (SELECT m."text" FROM "sites"."assist_site_messages" m
                  WHERE m."conversationId" = c."id" AND m."role" = 'visitor'
                  ORDER BY m."createdAt" LIMIT 1) AS text, ${PAGE_SQL} AS page
           FROM "sites"."assist_site_conversation_labels" l
           JOIN "sites"."assist_site_conversations" c ON c."id" = l."conversationId"
          WHERE l."siteId" = $1 AND l."accountId" = $2 AND l."failureReason" = $3
            AND c."createdAt" >= $4 AND c."createdAt" < $5
          ORDER BY c."createdAt" DESC
          LIMIT 200`,
        siteId,
        accountId,
        f.reason,
        start,
        end,
      );
      f.examples = rows
        .filter((r) => r.text && (!f.page || pageKey(r.page) === f.page))
        .slice(0, 5)
        .map((r) =>
          maskForJournal(r.text as string)
            .replace(/\s+/g, ' ')
            .slice(0, 200),
        );
    }
  }

  // ── калибровка lead score (Pro, §5-тер.4) ─────────────────────────────

  async calibrate(
    accountId: string,
    siteId: string,
    analytics: unknown,
    now: Date,
  ): Promise<boolean> {
    const windowDays = effectiveAnalyticsConfig(analytics).linkedWindowDays;
    // Известный исход: конверсия (любой режим) — 1; «не купил» — только
    // связанный режим с закрытым окном (без согласия межстраничные конверсии
    // не видны — такие диалоги в калибровку не идут, §5-тер.4).
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{ score: number; y: boolean; linked: boolean; closed: boolean }>
    >(
      `SELECT l."leadScore" AS score,
              EXISTS (SELECT 1 FROM "sites"."assist_site_goal_events" e
                       WHERE e."conversationId" = l."conversationId" AND e."status" = 'completed'
                         AND e."attribution" IN ('direct', 'assisted')) AS y,
              c."visitHash" IS NOT NULL AS linked,
              c."lastMessageAt" < $3 AS closed
         FROM "sites"."assist_site_conversation_labels" l
         JOIN "sites"."assist_site_conversations" c ON c."id" = l."conversationId"
        WHERE l."siteId" = $1 AND l."accountId" = $2 AND l."status" = 'ok'
          AND l."leadScore" IS NOT NULL`,
      siteId,
      accountId,
      new Date(now.getTime() - windowDays * DAY),
    );
    const known = rows
      .filter((r) => r.y || (r.linked && r.closed))
      .map((r) => ({ score: Number(r.score), y: (r.y ? 1 : 0) as 0 | 1 }));
    const positives = known.filter((r) => r.y === 1).length;
    if (
      positives < CALIBRATION_MIN_POSITIVES ||
      known.length < CALIBRATION_MIN_TOTAL
    ) {
      return false;
    }
    const platt = fitPlatt(known);
    if (!platt) return false;
    const probs = known.map((r) => ({ p: plattProb(r.score, platt), y: r.y }));
    const [last] = await this.prisma.$queryRawUnsafe<
      Array<{ v: number | null }>
    >(
      `SELECT max("version") AS v FROM "sites"."assist_site_lead_calibrations"
        WHERE "siteId" = $1 AND "accountId" = $2`,
      siteId,
      accountId,
    );
    await this.prisma.assistSiteLeadCalibration.create({
      data: {
        accountId,
        siteId,
        version: Number(last?.v ?? 0) + 1,
        method: 'platt',
        params: platt as unknown as Prisma.InputJsonValue,
        positives,
        total: known.length,
        auc: auc(probs),
        brier: brier(probs),
        ece: ece(probs),
      },
    });
    return true;
  }

  // ── «Сделано» → до/после через 14 дней (§5-тер.5) ─────────────────────

  async followUps(
    accountId: string,
    siteId: string,
    tz: string,
    now: Date,
  ): Promise<number> {
    const due = await this.prisma.assistSiteInsight.findMany({
      where: {
        siteId,
        accountId,
        status: 'done',
        followUp: { equals: Prisma.DbNull },
        doneAt: { lte: new Date(now.getTime() - FOLLOW_UP_DAYS * DAY) },
      },
      select: { id: true, finding: true, doneAt: true },
      take: 20,
    });
    let n = 0;
    for (const d of due) {
      const f = d.finding as unknown as Finding;
      const from = dayInTz(d.doneAt as Date, tz);
      const to = addDays(from, FOLLOW_UP_DAYS - 1);
      const after = metricFor(
        f,
        await this.inputs(accountId, siteId, tz, from, to),
      );
      const before =
        f.code === 'N8' || f.code === 'N2'
          ? { value: f.code === 'N2' ? f.n : f.value }
          : { x: f.x, n: f.n, share: f.share };
      await this.prisma.assistSiteInsight.update({
        where: { id: d.id },
        data: {
          followUp: {
            at: now.toISOString(),
            from,
            to,
            before,
            after,
            // Совпадение во времени, не доказательство (§5-тер.5).
            note: 'coincidence_not_proof',
          } as Prisma.InputJsonValue,
        },
      });
      n++;
    }
    return n;
  }
}
