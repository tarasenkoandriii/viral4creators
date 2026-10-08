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
 * Язык — получателей (заход 9, Р-З9-7): основной — владельца, переводы для
 * остальных участников в том же вызове, каждый — та же проверка чисел.
 * Start/Trial — находки кодом без модели (сухие строки, §5-тер.17).
 * Заход 10: N1/N9 — по сырым итогам просмотров недели (visitInputs, связка
 * диалог↔просмотр по признакам), N11 — по версиям базы прошлой недели и
 * свёртке поведения (pageChanges); без миграций.
 */
import { Injectable, Logger, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { SitesDb } from '../../../prisma/sites-db.service';
import { estimateCost } from '../../../shared/ai-pricing';
import type { CronScope } from '../../../common/cron-scope';
import { ASSIST_PLANS } from '../../assist-billing/plans';
import { readState } from '../../assist-billing/public/entitlements';
import { recipientsWithLang } from '../../assist-knowledge-core/notify';
import { maskForJournal } from '../../assist-site-chat/answer-checks';
import { geminiOutputCeiling } from '../../site-ai/gemini-output';
import {
  GeminiText,
  TextModelError,
  spentOf,
  type TextModelSpent,
} from '../../site-ai/text-model';
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
import { RAW_PAGE_VIEWS_RETENTION_MS } from '../behavior/behavior-rollup.service';
import { analyticsModel } from './ai-env';
import { AnalyticsBudget } from './analytics-budget';
import {
  FINDING_THRESHOLDS,
  buildInsightPrompt,
  detectFindings,
  hasExternalLink,
  metricFor,
  parseInsights,
  type Finding,
  type FindingInputs,
  type InsightLang,
  type StoredInsightText,
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
/** Видимый ответ на N языков (основной + переводы) — тот же запас на каждый. */
export function insightMaxOutput(langs: number): number {
  return INSIGHT_MAX_OUTPUT * Math.max(1, langs);
}

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

/** Первый день (пояс сайта), целиком лежащий в сырых просмотрах (7 дней). */
export function rawFirstDay(now: Date, tz: string): string {
  return addDays(
    dayInTz(new Date(now.getTime() - RAW_PAGE_VIEWS_RETENTION_MS), tz),
    1,
  );
}

const maxDay = (a: string, b: string) => (a > b ? a : b);

/** N1/N9: потолок времени запроса по сырым просмотрам (аудит P2-2). */
export const VISIT_QUERY_TIMEOUT_MS = 25_000;
/** N1/N9: потолки выборок (сверх — случайная выборка по md5 id). */
export const VISIT_VIEWS_MAX = 100_000;
export const VISIT_DIALOGS_MAX = 20_000;
/** Сколько просмотров назад (по началу) проверять при сопоставлении. */
const MATCH_CANDIDATES = 5;
/** Допуск: просмотр шёл в момент вопроса (±5 с). */
const MATCH_SLACK_MS = 5_000;

/**
 * Просмотр диалога: среди начавшихся не позже вопроса (список — по началу)
 * — ближайший из `MATCH_CANDIDATES` назад, который ещё шёл в момент
 * вопроса (аудит P3-5: не только последний по началу). Экспорт — тестам.
 */
export function matchView<T extends { startedAt: Date; endedAt: Date }>(
  list: readonly T[],
  at: number,
): T | null {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].startedAt.getTime() <= at) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo - 1; i >= 0 && i >= lo - MATCH_CANDIDATES; i--) {
    if (list[i].endedAt.getTime() >= at - MATCH_SLACK_MS) return list[i];
  }
  return null;
}

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
    @Optional() private readonly sitesDb?: SitesDb,
  ) {}

  /**
   * Языки выводов (Р-З9-7, хвост Э3-бис (9)): основной — язык владельца
   * (Telegram `language_code`, assist_bot_users), остальные — языки прочих
   * участников кабинета (они читают отчёт и экран на своём). Нет данных — uk.
   */
  async insightLangs(accountId: string): Promise<InsightLang[]> {
    if (!this.sitesDb) return ['uk'];
    const owners = await recipientsWithLang(
      this.sitesDb,
      accountId,
      (m) => m.role === 'owner',
    );
    const all = await recipientsWithLang(this.sitesDb, accountId, () => true);
    const out: InsightLang[] = [];
    for (const r of [...owners, ...all]) {
      if (!out.includes(r.lang)) out.push(r.lang);
    }
    return out.length ? out : ['uk'];
  }

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
      { visits: true, changes: true },
    );
    const findings = detectFindings(inputs);
    await this.examples(accountId, siteId, tz, weekStart, findings);
    out.findings = findings.length;

    const texts = new Map<number, StoredInsightText>();
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
    texts: Map<number, StoredInsightText>;
    rejected: Map<number, string>;
    skipped: string | null;
    cost: number;
  }> {
    const texts = new Map<number, StoredInsightText>();
    const rejected = new Map<number, string>();
    const niche =
      summary &&
      typeof summary === 'object' &&
      typeof (summary as { businessType?: unknown }).businessType === 'string'
        ? (summary as { businessType: string }).businessType.slice(0, 80)
        : null;
    // Язык получателей (Р-З9-7, заход 9): основной — владельца, переводы —
    // для остальных участников; один вызов, каждый язык — своя проверка чисел.
    const [lang, ...extraLangs] = await this.insightLangs(accountId);
    const prompt = buildInsightPrompt({
      findings,
      siteName,
      niche,
      lang,
      extraLangs,
    });
    // Переводы — в том же ответе: потолок растёт с числом языков (иначе
    // ответ обрезается и выводы целиком уходят в сухие строки).
    const maxOutput = insightMaxOutput(1 + extraLangs.length);
    const est = estimateCost(
      model,
      {
        inputTokens: Math.ceil((prompt.system.length + prompt.user.length) / 2),
        // Сверху — потолок, который уходит провайдеру (с запасом на мысли).
        outputTokens: geminiOutputCeiling(maxOutput),
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
    const record = async (out: TextModelSpent) => {
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
    };
    try {
      const out = await this.text.generate({
        system: prompt.system,
        user: prompt.user,
        json: true,
        temperature: 0.2,
        maxOutputTokens: maxOutput,
        model,
      });
      await record(out);
      settled = true;
      await this.budget.settle(rsv.reservation, cost);
      const parsed = parseInsights(out.text, findings, extraLangs, lang);
      if (parsed.invalid) return { texts, rejected, skipped: 'model', cost };
      for (const a of parsed.accepted) {
        const stored: StoredInsightText = {
          ...a.text,
          lang,
          ...(a.i18n ? { i18n: a.i18n } : {}),
        };
        for (const i of a.findingIndexes)
          if (!texts.has(i)) texts.set(i, stored);
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
        // empty/truncated оплачены: расход — как у ответа, резерв — фактом.
        // Сбой этой записи — резерв остаётся расходом (как ниже), а исход
        // тот же: выводы без модели.
        const spent = spentOf(e);
        const recorded = spent
          ? await record(spent).then(
              () => true,
              () => false,
            )
          : true;
        if (!settled && recorded) {
          await this.budget.settle(rsv.reservation, cost);
        }
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
    /**
     * Недельный прогон: ещё N1/N9 (`visits` — сырые просмотры) и N11
     * (`changes` — версии базы); сверка «до/после» — только нужное находке.
     */
    opts: { visits?: boolean; changes?: boolean } = {},
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
        chatOpens: number;
        fields: unknown;
        lcp: number | null;
        inp: number | null;
        cls: number | null;
      }>
    >(
      `SELECT "path", sum("views")::int AS views, sum("rage")::int AS rage,
              sum("jsErrors")::int AS "jsErrors", sum("formStarts")::int AS "formStarts",
              sum("formAbandons")::int AS "formAbandons",
              sum("chatOpens")::int AS "chatOpens",
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
      chatOpens: Number(r.chatOpens),
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
      ...(opts.visits
        ? await this.visitInputs(accountId, siteId, start, end)
        : {}),
      ...(opts.changes
        ? {
            pageChanges: await this.pageChanges(
              accountId,
              siteId,
              tz,
              fromDay,
              toDay,
            ),
          }
        : {}),
    };
  }

  /**
   * N1 и N9 (заход 10) — по СЫРЫМ итогам просмотров (7 дней; недельный
   * прогон идёт в начале следующей недели, неделя ещё целиком в сырых).
   * Связки «диалог ↔ просмотр» в базе нет (просмотр без ключа визита, по
   * построению §5-тер.8), поэтому сопоставление — по признакам:
   *  - просмотр диалога — с открытым чатом, тот же нормализованный путь,
   *    начался до первого вопроса и шёл в момент вопроса (±5 с); из
   *    нескольких кандидатов назад — ближайший по началу;
   *  - «без перехода по сайту» — нет просмотра того же устройства/ОС/
   *    браузера с `prevPath` = путь (не перезагрузка той же страницы),
   *    начавшегося от −10 до +60 с от конца;
   *  - «уход без прокрутки» (N9) — прокрутка < 10% и тот же «без перехода»;
   *  - время ответа (N1) — завершение ответа помощника (`updatedAt`
   *    готового сообщения), не вопрос.
   * Совпадения признаков у двух посетителей в одну минуту на одной странице
   * возможны — это оценка (умолчания ТЗ «уточнить на пилотах»).
   * Аудит P2-2: один запрос; «перешёл дальше» — окно по (путь, устройство,
   * ОС, браузер, время) вместо попарного соединения, только для просмотров с
   * чатом или кампанией; потолок времени запроса — `VISIT_QUERY_TIMEOUT_MS`
   * (истёк — N1/N9 этой недели нет, остальное считается). Выборки сверх
   * потолков — случайные (md5 id), а не начало недели.
   */
  private async visitInputs(
    accountId: string,
    siteId: string,
    start: Date,
    end: Date,
  ): Promise<Pick<FindingInputs, 'afterAnswer' | 'campaigns'>> {
    const p = this.prisma;
    const utcDay = (d: Date) => d.toISOString().slice(0, 10);
    const from = new Date(start.getTime() - DAY);
    const to = new Date(end.getTime() + 60 * 60 * 1000);
    type Row = {
      row: 'v' | 'c';
      path: string | null;
      startedAt: Date | null;
      endedAt: Date | null;
      campaign: string | null;
      moved: boolean | null;
      views: number | null;
      bounces: number | null;
    };
    let rows: Row[];
    try {
      const [, r] = await p.$transaction([
        p.$executeRawUnsafe(
          `SET LOCAL statement_timeout = ${VISIT_QUERY_TIMEOUT_MS}`,
        ),
        p.$queryRawUnsafe<Row[]>(
          // Окно просмотров: сутки до недели (диалог начала недели) и час после.
          `WITH w AS MATERIALIZED (
             SELECT "id", "path", "prevPath", "device", "os", "browser", "utmCampaign",
                    "scrollMax", "chatOpened", "startedAt",
                    "startedAt" + "totalMs" * interval '1 millisecond' AS "endedAt",
                    (1.0 / GREATEST("sampleRate", 0.001))::float8 AS w
               FROM "sites"."assist_site_page_views"
              WHERE "siteId" = $1 AND "day" >= $2 AND "day" <= $3
                AND "startedAt" >= $4 AND "startedAt" < $5
           ),
           ev AS (
             SELECT "id", "path" AS k, "device", "os", "browser", "endedAt" AS t, 0 AS kind
               FROM w WHERE "chatOpened" OR "utmCampaign" IS NOT NULL
             UNION ALL
             SELECT "id", "prevPath", "device", "os", "browser", "startedAt", 1
               FROM w WHERE "prevPath" IS NOT NULL AND "prevPath" <> "path"
           ),
           moved AS MATERIALIZED (
             SELECT "id" FROM (
               SELECT "id", kind, count(*) FILTER (WHERE kind = 1) OVER (
                        PARTITION BY k, "device", "os", "browser" ORDER BY t
                        RANGE BETWEEN interval '10 seconds' PRECEDING
                                  AND interval '60 seconds' FOLLOWING) AS nxt
                 FROM ev) x
              WHERE kind = 0 AND nxt > 0
           )
           SELECT 'v' AS row, c."path", c."startedAt", c."endedAt", c."utmCampaign" AS campaign,
                  (c."id" IN (SELECT "id" FROM moved)) AS moved,
                  NULL::float8 AS views, NULL::float8 AS bounces
             FROM (SELECT * FROM w WHERE "chatOpened"
                    ORDER BY md5("id") LIMIT ${VISIT_VIEWS_MAX}) c
           UNION ALL
           SELECT * FROM (
             SELECT 'c', NULL::text, NULL::timestamp, NULL::timestamp, c."utmCampaign", NULL::boolean,
                    sum(c.w)::float8,
                    COALESCE(sum(c.w) FILTER (WHERE c."scrollMax" < $6
                      AND c."id" NOT IN (SELECT "id" FROM moved)), 0)::float8
               FROM w c
              WHERE c."utmCampaign" IS NOT NULL AND c."startedAt" >= $7 AND c."startedAt" < $8
              GROUP BY c."utmCampaign" ORDER BY 7 DESC LIMIT 50) agg`,
          siteId,
          utcDay(from),
          utcDay(to),
          from,
          to,
          FINDING_THRESHOLDS.n9NoScrollPct,
          start,
          end,
        ),
      ]);
      rows = r;
    } catch (e) {
      this.logger.warn(
        `N1/N9 ${siteId}: просмотры не посчитаны (${(e as Error | null)?.name ?? 'Error'})`,
      );
      return {};
    }
    const chatViews = rows
      .filter((r) => r.row === 'v' && r.path && r.startedAt && r.endedAt)
      .map((r) => ({
        path: r.path as string,
        startedAt: r.startedAt as Date,
        endedAt: r.endedAt as Date,
        campaign: r.campaign,
        moved: !!r.moved,
      }))
      .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
    const campaignViews = rows
      .filter((r) => r.row === 'c' && r.campaign)
      .map((r) => ({
        campaign: r.campaign as string,
        views: Number(r.views ?? 0),
        bounces: Number(r.bounces ?? 0),
      }));
    const dialogs = await p.$queryRawUnsafe<
      Array<{
        page: string;
        createdAt: Date;
        answeredAt: Date | null;
        topics: string[] | null;
        w: number;
        mismatch: boolean;
      }>
    >(
      `SELECT ${PAGE_SQL} AS page, c."createdAt", l."topics", l."weight"::float8 AS w,
              (COALESCE(l."failureReason", '') = 'product_mismatch'
                OR COALESCE(l."intent", '') = 'offtopic_spam') AS mismatch,
              (SELECT max(m."updatedAt") FROM "sites"."assist_site_messages" m
                WHERE m."conversationId" = c."id" AND m."role" = 'assistant'
                  AND m."streamState" IN ('complete', 'partial')) AS "answeredAt"
         FROM "sites"."assist_site_conversation_labels" l
         JOIN "sites"."assist_site_conversations" c ON c."id" = l."conversationId"
        WHERE l."siteId" = $1 AND l."accountId" = $2
          AND c."createdAt" >= $3 AND c."createdAt" < $4
          AND l."status" IN ('ok', 'injection_suspect') AND l."weight" > 0
        ORDER BY md5(c."id") LIMIT ${VISIT_DIALOGS_MAX}`,
      siteId,
      accountId,
      start,
      end,
    );
    // Просмотры с чатом по пути, по времени начала (для поиска ближайшего).
    const byPath = new Map<string, typeof chatViews>();
    for (const v of chatViews) {
      const list = byPath.get(v.path) ?? [];
      list.push(v);
      byPath.set(v.path, list);
    }
    const after = new Map<
      string,
      { page: string; topic: string; n: number; x: number }
    >();
    const camp = new Map<string, { dialogs: number; mismatch: number }>();
    for (const d of dialogs) {
      const page = pageKey(d.page);
      const view = matchView(byPath.get(page) ?? [], d.createdAt.getTime());
      if (!view) continue;
      const w = Number(d.w);
      if (view.campaign && !hasExternalLink(view.campaign)) {
        const c = camp.get(view.campaign) ?? { dialogs: 0, mismatch: 0 };
        c.dialogs += w;
        if (d.mismatch) c.mismatch += w;
        camp.set(view.campaign, c);
      }
      if (!d.answeredAt) continue;
      const left =
        !view.moved &&
        view.endedAt.getTime() <=
          d.answeredAt.getTime() + FINDING_THRESHOLDS.n1LeaveMs;
      for (const raw of d.topics ?? []) {
        const topic = maskForJournal(raw).slice(0, 120);
        if (!topic) continue;
        const k = `${page}\u0000${topic}`;
        const a = after.get(k) ?? { page, topic, n: 0, x: 0 };
        a.n += w;
        if (left) a.x += w;
        after.set(k, a);
      }
    }
    return {
      afterAnswer: [...after.values()].map((a) => ({
        ...a,
        n: Math.round(a.n),
        x: Math.round(a.x),
      })),
      campaigns: campaignViews
        // Кампания — ввод посетителя (`?utm_campaign=`): ссылка/домен в
        // названии не доходит ни до модели, ни до отчёта владельцу.
        .filter((c) => !hasExternalLink(c.campaign))
        .map((c) => ({
          campaign: c.campaign,
          dialogs: Math.round(camp.get(c.campaign)?.dialogs ?? 0),
          mismatch: Math.round(camp.get(c.campaign)?.mismatch ?? 0),
          views: Math.round(c.views),
          bounces: Math.round(c.bounces),
        })),
    };
  }

  /**
   * N11 (заход 10): страницы, изменённые версиями базы, опубликованными за
   * неделю ДО анализируемой (каждая версия попадает ровно в одну неделю, а
   * окно «после» — от следующего дня до конца анализируемой, 7–13 дней).
   * Изменённая страница версии — документ-страница, переиндексированный во
   * время её сборки (`indexedAt` между созданием и публикацией; первая
   * версия сайта — не изменение). Метрика — доля просмотров с открытым чатом
   * из свёртки поведения: 14 дней до дня публикации против «после».
   */
  private async pageChanges(
    accountId: string,
    siteId: string,
    tz: string,
    fromDay: string,
    toDay: string,
  ): Promise<NonNullable<FindingInputs['pageChanges']>> {
    const p = this.prisma;
    const versions = await p.$queryRawUnsafe<
      Array<{ number: number; createdAt: Date; publishedAt: Date }>
    >(
      `SELECT "number", "createdAt", "publishedAt" FROM "sites"."assist_site_knowledge_versions"
        WHERE "siteId" = $1 AND "accountId" = $2 AND "parentNumber" IS NOT NULL
          AND "publishedAt" IS NOT NULL AND "publishedAt" >= $3 AND "publishedAt" < $4
        ORDER BY "publishedAt" DESC LIMIT 20`,
      siteId,
      accountId,
      dayRangeUtc(addDays(fromDay, -7), tz).start,
      dayRangeUtc(fromDay, tz).start,
    );
    const out: NonNullable<FindingInputs['pageChanges']> = [];
    const seen = new Set<string>();
    for (const v of versions) {
      const docs = await p.$queryRawUnsafe<Array<{ url: string }>>(
        `SELECT "url" FROM "sites"."assist_site_documents"
          WHERE "siteId" = $1 AND "accountId" = $2 AND "kind" = 'page'
            AND "url" IS NOT NULL AND "status" = 'active'
            AND "indexedAt" >= $3 AND "indexedAt" <= $4
          LIMIT 200`,
        siteId,
        accountId,
        v.createdAt,
        v.publishedAt,
      );
      const paths = [
        ...new Set(
          docs
            .map((d) => {
              try {
                return normalizePath(new URL(d.url).pathname);
              } catch {
                return null;
              }
            })
            .filter((x): x is string => !!x && !seen.has(x)),
        ),
      ].slice(0, 50);
      if (!paths.length) continue;
      // Страница, изменённая несколькими версиями, — по последней.
      for (const x of paths) seen.add(x);
      const day = dayInTz(v.publishedAt, tz);
      const b0 = addDays(day, -FINDING_THRESHOLDS.n11BeforeDays);
      const b1 = addDays(day, -1);
      const a0 = addDays(day, 1);
      const rows = await p.$queryRawUnsafe<
        Array<{
          path: string;
          bv: number | null;
          bc: number | null;
          av: number | null;
          ac: number | null;
        }>
      >(
        `SELECT "path",
                sum("views") FILTER (WHERE "day" <= $5)::int AS bv,
                sum("chatOpens") FILTER (WHERE "day" <= $5)::int AS bc,
                sum("views") FILTER (WHERE "day" >= $6)::int AS av,
                sum("chatOpens") FILTER (WHERE "day" >= $6)::int AS ac
           FROM "sites"."assist_site_daily_pages"
          WHERE "siteId" = $1 AND "accountId" = $2 AND "path" = ANY($3::text[])
            AND "day" >= $4 AND "day" <= $7
          GROUP BY "path"`,
        siteId,
        accountId,
        paths,
        b0,
        b1,
        a0,
        toDay,
      );
      for (const r of rows) {
        out.push({
          page: r.path,
          changedAt: day,
          version: v.number,
          before: { views: Number(r.bv ?? 0), chatOpens: Number(r.bc ?? 0) },
          after: { views: Number(r.av ?? 0), chatOpens: Number(r.ac ?? 0) },
        });
      }
    }
    return out;
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
    // не видны — такие диалоги в калибровку не идут, §5-тер.4). «Связан» —
    // флаг разметки (Р-З9-26: хеш визита диалога обнуляется через 31 день),
    // хеш — для связи, появившейся после разметки и до суточной уборки.
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{ score: number; y: boolean; linked: boolean; closed: boolean }>
    >(
      `SELECT l."leadScore" AS score,
              EXISTS (SELECT 1 FROM "sites"."assist_site_goal_events" e
                       WHERE e."conversationId" = l."conversationId" AND e."status" = 'completed'
                         AND e."attribution" IN ('direct', 'assisted')) AS y,
              (l."linked" OR c."visitHash" IS NOT NULL) AS linked,
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
      // N1/N9 — по сырым просмотрам (7 дней, аудит P2-3): окно сверки —
      // только доступная часть (фактические from/to и n пишутся в сверку);
      // n ниже порога находки — «недостаточно данных», а не доля по горстке.
      const visits = f.code === 'N1' || f.code === 'N9';
      const winFrom = visits ? maxDay(from, rawFirstDay(now, tz)) : from;
      let after: ReturnType<typeof metricFor> = null;
      let reason: 'insufficient_data' | null = null;
      if (winFrom <= to) {
        after = metricFor(
          f,
          await this.inputs(accountId, siteId, tz, winFrom, to, { visits }),
        );
      }
      const minN =
        f.code === 'N1'
          ? FINDING_THRESHOLDS.n1MinDialogs
          : f.code === 'N9'
            ? FINDING_THRESHOLDS.n9MinDialogs
            : 0;
      const afterN = after && 'n' in after ? after.n : null;
      if (visits && (afterN === null || afterN < minN)) {
        after = null;
        reason = 'insufficient_data';
      }
      const before =
        f.code === 'N8' || f.code === 'N2'
          ? { value: f.code === 'N2' ? f.n : f.value }
          : { x: f.x, n: f.n, share: f.share };
      await this.prisma.assistSiteInsight.update({
        where: { id: d.id },
        data: {
          followUp: {
            at: now.toISOString(),
            from: winFrom,
            to,
            n: afterN,
            before,
            after,
            reason,
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
