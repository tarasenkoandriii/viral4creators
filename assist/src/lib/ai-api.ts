/**
 * Клиент Э3-бис «Аналитика с ИИ» (REST sites-backend, doc/API.md §Э3-бис).
 * Разбор строгий: перечни — только известные значения (неизвестное — как
 * «нет»), числа — конечные, текст модели — только строки (рисуется
 * текстом, не HTML). Текста посетителей здесь нет вовсе.
 */

import type { ApiClient } from '../kit';
import { iso, num, seg } from './handoff-api';
import {
  AI_FAILURES,
  AI_INTENTS,
  AI_STAGES,
  EXPERIMENT_KINDS,
  FINDING_CODES,
  LEAD_BUCKETS,
  LEAD_FEATURES,
  VERTICALS,
  type AiDialogView,
  type AiDialogsPage,
  type AiPlanView,
  type AiSettings,
  type AiSummaryView,
  type BehaviorView,
  type Dist,
  type ExperimentRequest,
  type ExperimentResultView,
  type ExperimentView,
  type FindingView,
  type InsightView,
  type InsightsView,
  type PowerView,
} from './ai-types';
import { arr, obj, oneOf, str, text } from './widget-api';

const n0 = (v: unknown): number => num(v) ?? 0;
const bool = (v: unknown): boolean => v === true;
const pick = <T extends string>(all: readonly T[], v: unknown): T | null =>
  (all as readonly unknown[]).includes(v) ? (v as T) : null;

export function parsePlan(v: unknown): AiPlanView {
  const o = obj(v);
  return {
    planId: str(o.planId),
    aiAnalytics: bool(o.aiAnalytics),
    leadCalibration: bool(o.leadCalibration),
    experiments: bool(o.experiments),
    linkedWindowDays: n0(o.linkedWindowDays),
    behaviorViewsPerMonth: n0(o.behaviorViewsPerMonth),
  };
}

const dist = (v: unknown): Dist[] =>
  arr(v)
    .map((x) => {
      const o = obj(x);
      return { key: text(o.key), n: n0(o.n) };
    })
    .filter((d) => d.key);

export function parseSummary(v: unknown): AiSummaryView {
  const o = obj(v);
  const m = obj(o.model);
  const b = obj(o.budget);
  const c = obj(o.coverage);
  const k = obj(o.buckets);
  const cal = o.calibration ? obj(o.calibration) : null;
  return {
    plan: parsePlan(o.plan),
    model: { ok: bool(m.ok), reason: str(m.reason) },
    budget: {
      period: text(b.period),
      capMicroUsd: n0(b.capMicroUsd),
      spentMicroUsd: n0(b.spentMicroUsd),
    },
    coverage: {
      closed: n0(c.closed),
      labeled: n0(c.labeled),
      failed: n0(c.failed),
      skipped: n0(c.skipped),
      injection: n0(c.injection),
      pending: n0(c.pending),
      sampled: bool(c.sampled),
    },
    buckets: {
      hot: n0(k.hot),
      warm: n0(k.warm),
      cold: n0(k.cold),
      hotNoLead: n0(k.hotNoLead),
    },
    intents: dist(o.intents),
    stages: dist(o.stages),
    outcomes: dist(o.outcomes),
    failureReasons: dist(o.failureReasons),
    overridden: n0(o.overridden),
    calibration: cal
      ? {
          version: n0(cal.version),
          method: text(cal.method),
          positives: n0(cal.positives),
          total: n0(cal.total),
          auc: num(cal.auc),
          brier: num(cal.brier),
          ece: num(cal.ece),
          createdAt: iso(cal.createdAt) ?? '',
        }
      : null,
  };
}

export function parseDialog(v: unknown): AiDialogView | null {
  const o = obj(v);
  const id = str(o.conversationId);
  if (!id) return null;
  return {
    conversationId: id,
    createdAt: iso(o.createdAt) ?? '',
    pagePath: str(o.pagePath),
    status: text(o.status),
    intent: pick(AI_INTENTS, o.intent),
    stage: pick(AI_STAGES, o.stage),
    outcome: str(o.outcome),
    failureReason: pick(AI_FAILURES, o.failureReason),
    leadScore: num(o.leadScore),
    leadBucket: pick(LEAD_BUCKETS, o.leadBucket),
    leadProb: num(o.leadProb),
    features: arr(o.features)
      .map((x) => {
        const f = obj(x);
        return {
          f: f.f as (typeof LEAD_FEATURES)[number],
          c: num(f.c) ?? 0,
        };
      })
      .filter((x) => (LEAD_FEATURES as readonly unknown[]).includes(x.f)),
    intentNote: str(o.intentNote),
    failureNote: str(o.failureNote),
    converted: bool(o.converted),
    lead: bool(o.lead),
    handoff: bool(o.handoff),
    weight: n0(o.weight),
    overridden: o.humanOverride !== null && typeof o.humanOverride === 'object',
  };
}

export function parseDialogs(v: unknown): AiDialogsPage {
  const o = obj(v);
  return {
    items: arr(o.items)
      .map(parseDialog)
      .filter((x): x is AiDialogView => x !== null),
    nextCursor: iso(o.nextCursor),
  };
}

function parseFinding(v: unknown): FindingView {
  const o = obj(v);
  return {
    n: n0(o.n),
    x: n0(o.x),
    share: n0(o.share),
    ciLow: n0(o.ciLow),
    ciHigh: n0(o.ciHigh),
    base: num(o.base),
    page: str(o.page),
    topic: str(o.topic),
    reason: str(o.reason),
    field: str(o.field),
    metric:
      o.metric === 'lcp' || o.metric === 'inp' || o.metric === 'cls'
        ? o.metric
        : null,
    value: num(o.value),
    trigger: str(o.trigger),
  };
}

export function parseInsight(v: unknown): InsightView | null {
  const o = obj(v);
  const id = str(o.id);
  const code = (FINDING_CODES as readonly unknown[]).includes(o.code)
    ? (o.code as InsightView['code'])
    : null;
  if (!id || !code) return null;
  const t = o.text ? obj(o.text) : null;
  const fu = o.followUp ? obj(o.followUp) : null;
  const side = (x: unknown) => {
    const s = obj(x);
    return { share: num(s.share) ?? undefined, value: num(s.value) };
  };
  return {
    id,
    code,
    impact:
      o.impact === 'high' || o.impact === 'medium'
        ? o.impact
        : ('low' as const),
    finding: parseFinding(o.finding),
    text:
      t && str(t.title) && str(t.what) && str(t.action)
        ? { title: text(t.title), what: text(t.what), action: text(t.action) }
        : null,
    textSkipped: str(o.textSkipped),
    status:
      o.status === 'done' || o.status === 'dismissed'
        ? o.status
        : ('new' as const),
    doneAt: iso(o.doneAt),
    followUp: fu
      ? {
          before: side(fu.before),
          after: fu.after
            ? {
                share: num(obj(fu.after).share) ?? undefined,
                value: num(obj(fu.after).value) ?? undefined,
              }
            : null,
        }
      : null,
    feedback: o.feedback === 1 || o.feedback === -1 ? o.feedback : null,
  };
}

export function parseInsights(v: unknown): InsightsView {
  const o = obj(v);
  const m = obj(o.model);
  return {
    weeks: arr(o.weeks).filter((x): x is string => typeof x === 'string'),
    weekStart: str(o.weekStart),
    items: arr(o.items)
      .map(parseInsight)
      .filter((x): x is InsightView => x !== null),
    plan: parsePlan(o.plan),
    model: { ok: bool(m.ok), reason: str(m.reason) },
  };
}

export function parsePower(v: unknown): PowerView {
  const o = obj(v);
  const mde = num(o.mdeRel);
  return {
    units28: n0(o.units28),
    conversions28: n0(o.conversions28),
    baseRate: n0(o.baseRate),
    unitsPerDay: n0(o.unitsPerDay),
    expectedUnits: n0(o.expectedUnits),
    mdeRel: mde,
    minUnitsPerArm: n0(o.minUnitsPerArm),
    ok: bool(o.ok),
    reason:
      o.reason === 'no_traffic' ||
      o.reason === 'no_conversions' ||
      o.reason === 'underpowered'
        ? o.reason
        : null,
  };
}

function parseResult(v: unknown): ExperimentResultView | null {
  if (!v || typeof v !== 'object') return null;
  const o = obj(v);
  return {
    nA: n0(o.nA),
    nB: n0(o.nB),
    xA: n0(o.xA),
    xB: n0(o.xB),
    rateA: n0(o.rateA),
    rateB: n0(o.rateB),
    diff: n0(o.diff),
    ciLow: n0(o.ciLow),
    ciHigh: n0(o.ciHigh),
    p: num(o.p),
    liftRel: num(o.liftRel),
    verdict:
      o.verdict === 'significant' || o.verdict === 'not_significant'
        ? o.verdict
        : 'insufficient_sample',
    goalTrust: o.goalTrust
      ? {
          total: n0(obj(o.goalTrust).total),
          page: n0(obj(o.goalTrust).page),
          pageShare: num(obj(o.goalTrust).pageShare),
        }
      : null,
  };
}

export function parseExperiment(v: unknown): ExperimentView | null {
  const o = obj(v);
  const id = str(o.id);
  const kind = (EXPERIMENT_KINDS as readonly unknown[]).includes(o.kind)
    ? (o.kind as ExperimentView['kind'])
    : null;
  if (!id || !kind) return null;
  const u = obj(o.units);
  return {
    id,
    kind,
    goalKey: text(o.goalKey),
    share: n0(o.share),
    status:
      o.status === 'done' || o.status === 'invalid' || o.status === 'stopped'
        ? o.status
        : 'running',
    horizonDays: n0(o.horizonDays),
    startedAt: iso(o.startedAt) ?? '',
    endsAt: iso(o.endsAt) ?? '',
    stopReason: str(o.stopReason),
    mdeRel: n0(o.mdeRel),
    minUnitsPerArm: n0(o.minUnitsPerArm),
    units: { a: n0(u.a), b: n0(u.b) },
    srmP: num(o.srmP),
    // Итог — только у завершённого по горизонту (без подглядывания).
    result: o.status === 'done' ? parseResult(o.result) : null,
  };
}

export function parseBehavior(v: unknown): BehaviorView {
  const o = obj(v);
  const q = obj(o.quota);
  return {
    enabled: bool(o.enabled),
    reason: o.reason === 'plan' || o.reason === 'settings' ? o.reason : null,
    quota: {
      used: n0(q.used),
      limit: n0(q.limit),
      // До захода 9 сервер поля не слал — всё в квоте.
      sampleRate: num(q.sampleRate) ?? 1,
    },
    pages: arr(o.pages).map((x) => {
      const p = obj(x);
      return {
        path: text(p.path),
        views: n0(p.views),
        activeMsMedian: n0(p.activeMsMedian),
        scrollMedian: n0(p.scrollMedian),
        deepScrollShare: n0(p.deepScrollShare),
        backNav: n0(p.backNav),
        rage: n0(p.rage),
        jsErrors: n0(p.jsErrors),
        formStarts: n0(p.formStarts),
        formAbandons: n0(p.formAbandons),
        topAbandonField: str(p.topAbandonField),
        lcpP75: num(p.lcpP75),
        inpP75: num(p.inpP75),
        clsP75: num(p.clsP75),
        chatOpens: n0(p.chatOpens),
      };
    }),
    totalViews: n0(o.totalViews),
  };
}

export function parseAiSettings(v: unknown): AiSettings {
  const c = obj(obj(v).config);
  const w = num(c.linkedWindowDays);
  return {
    aiLabeling: c.aiLabeling !== false,
    vertical: oneOf(VERTICALS, c.vertical, 'other'),
    linked: c.linked === true,
    linkedGcm: c.linkedGcm === true,
    linkedWindowDays: w !== null && w >= 1 && w <= 30 ? w : 7,
    behavior: c.behavior === true,
  };
}

export interface AiApi {
  summary(siteId: string, from: string, to: string): Promise<AiSummaryView>;
  dialogs(
    siteId: string,
    q: {
      from: string;
      to: string;
      bucket?: string;
      intent?: string;
      stage?: string;
      failure?: string;
      cursor?: string;
    }
  ): Promise<AiDialogsPage>;
  fixLabel(
    siteId: string,
    conversationId: string,
    patch: Record<string, string | null>
  ): Promise<void>;
  /** `lang` — язык экрана: тексты выводов на нём (заход 9, Р-З9-7). */
  insights(
    siteId: string,
    week?: string,
    lang?: 'uk' | 'ru' | 'en'
  ): Promise<InsightsView>;
  markInsight(
    siteId: string,
    id: string,
    patch: { status?: 'new' | 'done' | 'dismissed'; feedback?: 1 | -1 | 0 }
  ): Promise<void>;
  behavior(siteId: string, from: string, to: string): Promise<BehaviorView>;
  experiments(siteId: string): Promise<ExperimentView[]>;
  preview(siteId: string, body: ExperimentRequest): Promise<PowerView>;
  startExperiment(
    siteId: string,
    body: ExperimentRequest
  ): Promise<ExperimentView | null>;
  stopExperiment(siteId: string, id: string): Promise<ExperimentView | null>;
  settings(siteId: string): Promise<AiSettings>;
  saveSettings(siteId: string, patch: Partial<AiSettings>): Promise<AiSettings>;
}

function qs(o: Record<string, string | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v) q.set(k, v);
  return q.toString();
}

export function createAiApi(client: ApiClient): AiApi {
  const s = (id: string) => `/assist/sites/${seg(id)}`;
  return {
    summary: async (id, from, to) =>
      parseSummary(
        await client.request('GET', `${s(id)}/ai/summary?${qs({ from, to })}`)
      ),
    dialogs: async (id, q) =>
      parseDialogs(await client.request('GET', `${s(id)}/ai/dialogs?${qs(q)}`)),
    fixLabel: async (id, cid, patch) => {
      await client.request(
        'PATCH',
        `${s(id)}/conversations/${seg(cid)}/label`,
        patch
      );
    },
    insights: async (id, week, lang) => {
      const q = qs({ week, lang });
      return parseInsights(
        await client.request(
          'GET',
          `${s(id)}/stats/insights${q ? `?${q}` : ''}`
        )
      );
    },
    markInsight: async (id, iid, patch) => {
      await client.request('PATCH', `${s(id)}/insights/${seg(iid)}`, patch);
    },
    behavior: async (id, from, to) =>
      parseBehavior(
        await client.request(
          'GET',
          `${s(id)}/stats/behavior?${qs({ from, to })}`
        )
      ),
    experiments: async (id) =>
      arr(await client.request('GET', `${s(id)}/experiments`))
        .map(parseExperiment)
        .filter((x): x is ExperimentView => x !== null),
    preview: async (id, body) =>
      parsePower(
        await client.request('POST', `${s(id)}/experiments/preview`, body)
      ),
    startExperiment: async (id, body) =>
      parseExperiment(
        await client.request('POST', `${s(id)}/experiments`, body)
      ),
    stopExperiment: async (id, eid) =>
      parseExperiment(
        await client.request('POST', `${s(id)}/experiments/${seg(eid)}/stop`)
      ),
    settings: async (id) =>
      parseAiSettings(
        await client.request('GET', `${s(id)}/analytics-settings`)
      ),
    saveSettings: async (id, patch) =>
      parseAiSettings(
        await client.request('PATCH', `${s(id)}/analytics-settings`, {
          config: patch,
        })
      ),
  };
}
