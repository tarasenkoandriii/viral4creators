/**
 * Клиент целей, статистики, экспорта и интеграций (Э3, REST агента A,
 * контракт §6). Разбор строгий (см. `handoff-api.ts`):
 * - детектор неизвестного вида не рисуется и обратно не уходит;
 * - ссылка выбора цели и экспорта — только https;
 * - секрет — только формат «печатные ASCII», показывается один раз;
 * - числа — только конечные; доли — 0…1; «шум» — строго true.
 */

import type { ApiClient } from '../kit';
import { iso, num, requestVoid, seg } from './handoff-api';
import {
  EXPORT_KINDS,
  EXPORT_STATUSES,
  GOAL_ATTRIBUTIONS,
  GOAL_TEMPLATES,
  GOAL_TRUSTS,
  VALUE_MODES,
  type AnalyticsConfig,
  type AnalyticsSettingsView,
  type ElementDescriptor,
  type ExportRequest,
  type ExportView,
  type GoalDetector,
  type GoalInput,
  type GoalPickerStatusView,
  type GoalPickerTokenView,
  type GoalRecentEventView,
  type GoalView,
  type IntegrationsView,
  type MetricView,
  type ReportSubscriptionView,
  type SecretIssuedView,
  type StatsConversionsView,
  type StatsOverviewView,
  type StatsPeriod,
  type StatsSitesView,
  type StatsTopicsView,
} from './stats-types';
import {
  ID,
  arr,
  count,
  obj,
  oneOf,
  safeHttpsUrl,
  str,
  strs,
  text,
} from './widget-api';
import { GOAL_WEBHOOK_PATH } from './public-api';

const n0 = (v: unknown): number => num(v) ?? 0;
const share = (v: unknown): number | null => {
  const x = num(v);
  return x !== null && x >= 0 && x <= 1 ? x : null;
};

export function parseDescriptor(v: unknown): ElementDescriptor {
  const o = obj(v);
  return {
    assistGoal: str(o.assistGoal),
    assistId: str(o.assistId),
    role: str(o.role),
    text: str(o.text),
    tag: str(o.tag),
  };
}

export function parseDetector(v: unknown): GoalDetector | null {
  const o = obj(v);
  const c = obj(o.config);
  switch (o.kind) {
    case 'url':
      return typeof c.pathMask === 'string'
        ? {
            kind: 'url',
            config: { pathMask: c.pathMask, fromPathMask: str(c.fromPathMask) },
          }
        : null;
    case 'click':
      if (c.auto === 'tel' || c.auto === 'messenger') {
        return { kind: 'click', config: { auto: c.auto } };
      }
      return c.descriptor && typeof c.descriptor === 'object'
        ? {
            kind: 'click',
            config: {
              descriptor: parseDescriptor(c.descriptor),
              pathMask: str(c.pathMask),
            },
          }
        : null;
    case 'form_submit':
      return c.descriptor && typeof c.descriptor === 'object'
        ? {
            kind: 'form_submit',
            config: {
              descriptor: parseDescriptor(c.descriptor),
              pathMask: str(c.pathMask),
            },
          }
        : null;
    case 'js':
      return { kind: 'js', config: {} };
    case 's2s':
      return { kind: 's2s', config: {} };
    case 'builtin':
      return { kind: 'builtin', config: { event: 'lead' } };
    case 'crm':
      return { kind: 'crm', config: { provider: 'woocommerce' } };
    default:
      return null;
  }
}

export function parseGoal(v: unknown): GoalView | null {
  const o = obj(v);
  if (typeof o.id !== 'string' || !ID.test(o.id)) return null;
  return {
    id: o.id,
    key: text(o.key),
    template: oneOf(GOAL_TEMPLATES, o.template, 'custom'),
    name: text(o.name),
    detectors: arr(o.detectors)
      .map(parseDetector)
      .filter((x): x is GoalDetector => !!x),
    valueMode: oneOf(VALUE_MODES, o.valueMode, 'none'),
    fixedValue: num(o.fixedValue),
    currency: str(o.currency),
    status: oneOf(['active', 'paused', 'stale'] as const, o.status, 'paused'),
    lastFiredAt: iso(o.lastFiredAt),
    createdAt: text(o.createdAt),
  };
}

export function parseGoals(v: unknown): GoalView[] {
  const list = Array.isArray(v) ? v : arr(obj(v).goals);
  return list.map(parseGoal).filter((x): x is GoalView => !!x);
}

export function parsePickerToken(v: unknown): GoalPickerTokenView {
  const o = obj(v);
  return {
    tokenId:
      typeof o.tokenId === 'string' && ID.test(o.tokenId) ? o.tokenId : '',
    url: safeHttpsUrl(o.url) ?? '',
    expiresAt: text(o.expiresAt),
  };
}

export function parsePickerStatus(v: unknown): GoalPickerStatusView {
  const o = obj(v);
  const r = o.result && typeof o.result === 'object' ? obj(o.result) : null;
  const status = oneOf(
    ['waiting', 'picked', 'expired'] as const,
    o.status,
    'expired'
  );
  return {
    status,
    result:
      r && status === 'picked'
        ? {
            descriptor: parseDescriptor(r.descriptor),
            path: text(r.path),
            label: text(r.label),
            kind: r.kind === 'form_submit' ? 'form_submit' : 'click',
          }
        : null,
  };
}

export function parseRecent(v: unknown): GoalRecentEventView[] {
  return arr(v).map((x) => {
    const o = obj(x);
    return {
      id: text(o.id),
      occurredAt: text(o.occurredAt),
      source: text(o.source),
      trust: oneOf(GOAL_TRUSTS, o.trust, 'page'),
      attribution: oneOf(GOAL_ATTRIBUTIONS, o.attribution, 'unknown'),
      path: str(o.path),
      orderId: str(o.orderId),
      value: num(o.value),
      currency: str(o.currency),
      status: oneOf(
        ['completed', 'refunded', 'cancelled'] as const,
        o.status,
        'completed'
      ),
    };
  });
}

export function parseMetric(v: unknown): MetricView {
  const o = obj(v);
  return {
    value: n0(o.value),
    prev: num(o.prev),
    deltaPct: num(o.deltaPct),
    noise: typeof o.noise === 'boolean' ? o.noise : null,
  };
}

function parsePeriod(v: unknown): StatsPeriod {
  const o = obj(v);
  return {
    from: text(o.from),
    to: text(o.to),
    attributionWindowOpenFrom: str(o.attributionWindowOpenFrom),
    timezone: text(o.timezone) || 'Europe/Kyiv',
  };
}

export function parseOverview(v: unknown): StatsOverviewView {
  const o = obj(v);
  const c = obj(o.conversions);
  return {
    period: parsePeriod(o.period),
    dialogs: parseMetric(o.dialogs),
    resolved: parseMetric(o.resolved),
    resolvedShare: parseMetric(o.resolvedShare),
    operatorHoursSaved: n0(o.operatorHoursSaved),
    minutesPerQuestion: n0(o.minutesPerQuestion),
    handoffs: parseMetric(o.handoffs),
    handoffsMissed: parseMetric(o.handoffsMissed),
    leads: parseMetric(o.leads),
    conversions: {
      total: parseMetric(c.total),
      direct: parseMetric(c.direct),
      assisted: parseMetric(c.assisted),
    },
    thumbsUpShare: parseMetric(o.thumbsUpShare),
    costMicroUsd: count(o.costMicroUsd),
    series: arr(o.series).map((x) => {
      const s = obj(x);
      return {
        day: text(s.day),
        dialogs: count(s.dialogs),
        resolved: count(s.resolved),
        handoffs: count(s.handoffs),
        leads: count(s.leads),
        conversions: count(s.conversions),
      };
    }),
  };
}

export function parseConversions(v: unknown): StatsConversionsView {
  const o = obj(v);
  return {
    period: parsePeriod(o.period),
    goals: arr(o.goals).map((x) => {
      const g = obj(x);
      const val = obj(g.value);
      return {
        goalId: text(g.goalId),
        key: text(g.key),
        name: text(g.name),
        total: count(g.total),
        direct: count(g.direct),
        assisted: count(g.assisted),
        unassisted: count(g.unassisted),
        refunds: count(g.refunds),
        value: {
          verified: n0(val.verified),
          page: n0(val.page),
          currency: str(val.currency),
        },
        dialogConversion: share(g.dialogConversion),
      };
    }),
    proactive: arr(o.proactive).map((x) => {
      const p = obj(x);
      return {
        key: text(p.key),
        shown: count(p.shown),
        accepted: count(p.accepted),
        dismissed: count(p.dismissed),
        dialogs: count(p.dialogs),
        conversions: count(p.conversions),
      };
    }),
  };
}

export function parseTopics(v: unknown): StatsTopicsView {
  const o = obj(v);
  return {
    period: parsePeriod(o.period),
    topics: arr(o.topics).map((x) => {
      const t = obj(x);
      return {
        clusterId: text(t.clusterId),
        label: text(t.label),
        kind: text(t.kind),
        distinctVisitors: count(t.distinctVisitors),
        dialogs: count(t.dialogs),
        conversions: count(t.conversions),
        unknownShare: share(t.unknownShare) ?? 0,
        status: oneOf(
          ['open', 'resolved', 'ignored'] as const,
          t.status,
          'open'
        ),
      };
    }),
    uncovered: count(o.uncovered),
  };
}

export function parseStatsSites(v: unknown): StatsSitesView {
  const o = obj(v);
  return {
    sites: arr(o.sites).map((x) => {
      const s = obj(x);
      return {
        siteId: text(s.siteId),
        name: text(s.name),
        dialogs: count(s.dialogs),
        resolvedShare: share(s.resolvedShare),
        conversions: count(s.conversions),
        costMicroUsd: count(s.costMicroUsd),
      };
    }),
  };
}

export function parseIntegrations(v: unknown): IntegrationsView {
  const o = obj(v);
  const w = obj(o.goalWebhook);
  const i = obj(o.identity);
  return {
    goalWebhook: {
      active: w.active === true,
      createdAt: iso(w.createdAt),
      lastUsedAt: iso(w.lastUsedAt),
      // Сервер отдаёт путь (без origin): полный адрес собирает экран
      // (goalWebhookUrl + PUBLIC_API_BASE). Иное — не показываем.
      endpoint:
        typeof w.endpoint === 'string' && GOAL_WEBHOOK_PATH.test(w.endpoint)
          ? w.endpoint
          : '',
    },
    identity: { active: i.active === true, createdAt: iso(i.createdAt) },
  };
}

/** Секрет — печатные ASCII без пробелов (иное не покажем как «секрет»). */
export function parseSecret(v: unknown): SecretIssuedView | null {
  const o = obj(v);
  const secret = text(o.secret);
  if (!/^[\x21-\x7E]{16,200}$/.test(secret)) return null;
  return {
    kind: o.kind === 'identity' ? 'identity' : 'goal_webhook',
    secret,
    createdAt: text(o.createdAt),
  };
}

export function parseExport(v: unknown): ExportView | null {
  const o = obj(v);
  if (typeof o.id !== 'string' || !ID.test(o.id)) return null;
  const status = oneOf(EXPORT_STATUSES, o.status, 'failed');
  return {
    id: o.id,
    kind: oneOf(EXPORT_KINDS, o.kind, 'daily'),
    status,
    rows: typeof o.rows === 'number' ? count(o.rows) : null,
    // Ссылка — только у готового и только https (приватный Blob, 24 ч).
    url: status === 'done' ? safeHttpsUrl(o.url) : null,
    expiresAt: iso(o.expiresAt),
    createdAt: text(o.createdAt),
  };
}

export function parseExports(v: unknown): ExportView[] {
  const list = Array.isArray(v) ? v : arr(obj(v).items);
  return list.map(parseExport).filter((x): x is ExportView => !!x);
}

export function parseSubscription(v: unknown): ReportSubscriptionView {
  const o = obj(v);
  return { weekly: o.weekly === true, digest: o.digest === true };
}

export function parseAnalyticsSettings(v: unknown): AnalyticsSettingsView {
  const o = obj(v);
  const c = obj(o.config);
  const config: AnalyticsConfig = {
    schema: 1,
    minutesPerQuestion: num(c.minutesPerQuestion) ?? 3,
    officeCidrs: strs(c.officeCidrs),
    excludedPaths: strs(c.excludedPaths),
  };
  return {
    config,
    timezone: text(o.timezone) || 'Europe/Kyiv',
    currency: /^[A-Z]{3}$/.test(text(o.currency)) ? text(o.currency) : 'UAH',
  };
}

/** Период запроса статистики: даты YYYY-MM-DD. */
export function statsQuery(p: {
  from: string;
  to: string;
  compare?: 'prev' | 'none';
}): string {
  const q = new URLSearchParams();
  const d = /^\d{4}-\d{2}-\d{2}$/;
  if (d.test(p.from)) q.set('from', p.from);
  if (d.test(p.to)) q.set('to', p.to);
  if (p.compare) q.set('compare', p.compare);
  return q.toString();
}

export interface StatsApi {
  goals(siteId: string): Promise<GoalView[]>;
  createGoal(siteId: string, goal: GoalInput): Promise<GoalView | null>;
  patchGoal(
    siteId: string,
    gid: string,
    patch: Partial<GoalInput> & { status?: 'active' | 'paused' }
  ): Promise<GoalView | null>;
  deleteGoal(siteId: string, gid: string): Promise<void>;
  pickerToken(
    siteId: string,
    body: { hostId: string; path?: string }
  ): Promise<GoalPickerTokenView>;
  pickerStatus(siteId: string, tokenId: string): Promise<GoalPickerStatusView>;
  recent(siteId: string, gid: string): Promise<GoalRecentEventView[]>;
  deleteGoalEvents(
    siteId: string,
    orderId: string
  ): Promise<{ deleted: number }>;
  overview(
    siteId: string,
    p: { from: string; to: string; compare?: 'prev' | 'none' }
  ): Promise<StatsOverviewView>;
  conversions(
    siteId: string,
    p: { from: string; to: string }
  ): Promise<StatsConversionsView>;
  topics(
    siteId: string,
    p: { from: string; to: string }
  ): Promise<StatsTopicsView>;
  sites(p: { from: string; to: string }): Promise<StatsSitesView>;
  analyticsSettings(siteId: string): Promise<AnalyticsSettingsView>;
  saveAnalyticsSettings(
    siteId: string,
    body: { config: AnalyticsConfig; timezone?: string; currency?: string }
  ): Promise<AnalyticsSettingsView>;
  integrations(siteId: string): Promise<IntegrationsView>;
  issueSecret(
    siteId: string,
    kind: 'goal-webhook' | 'identity'
  ): Promise<SecretIssuedView | null>;
  revokeIntegration(
    siteId: string,
    kind: 'goal-webhook' | 'identity'
  ): Promise<void>;
  createExport(siteId: string, body: ExportRequest): Promise<ExportView | null>;
  exports(siteId: string): Promise<ExportView[]>;
  exportOne(siteId: string, xid: string): Promise<ExportView | null>;
  subscription(siteId: string): Promise<ReportSubscriptionView>;
  saveSubscription(
    siteId: string,
    body: ReportSubscriptionView
  ): Promise<ReportSubscriptionView>;
}

export function createStatsApi(client: ApiClient): StatsApi {
  const s = (id: string) => `/assist/sites/${seg(id)}`;
  return {
    goals: async (id) =>
      parseGoals(await client.request('GET', `${s(id)}/goals`)),
    createGoal: async (id, goal) =>
      parseGoal(await client.request('POST', `${s(id)}/goals`, goal)),
    patchGoal: async (id, gid, patch) =>
      parseGoal(
        await client.request('PATCH', `${s(id)}/goals/${seg(gid)}`, patch)
      ),
    deleteGoal: (id, gid) =>
      requestVoid(client, 'DELETE', `${s(id)}/goals/${seg(gid)}`),
    pickerToken: async (id, body) =>
      parsePickerToken(
        await client.request('POST', `${s(id)}/goals/picker-token`, body)
      ),
    pickerStatus: async (id, tokenId) =>
      parsePickerStatus(
        await client.request('GET', `${s(id)}/goals/picker/${seg(tokenId)}`)
      ),
    recent: async (id, gid) =>
      parseRecent(
        await client.request('GET', `${s(id)}/goals/${seg(gid)}/recent`)
      ),
    deleteGoalEvents: async (id, orderId) => {
      const o = obj(
        await client.request(
          'DELETE',
          `${s(id)}/goal-events?orderId=${encodeURIComponent(orderId)}`
        )
      );
      return { deleted: count(o.deleted) };
    },
    overview: async (id, p) =>
      parseOverview(
        await client.request('GET', `${s(id)}/stats/overview?${statsQuery(p)}`)
      ),
    conversions: async (id, p) =>
      parseConversions(
        await client.request(
          'GET',
          `${s(id)}/stats/conversions?${statsQuery(p)}`
        )
      ),
    topics: async (id, p) =>
      parseTopics(
        await client.request('GET', `${s(id)}/stats/topics?${statsQuery(p)}`)
      ),
    sites: async (p) =>
      parseStatsSites(
        await client.request('GET', `/assist/stats/sites?${statsQuery(p)}`)
      ),
    analyticsSettings: async (id) =>
      parseAnalyticsSettings(
        await client.request('GET', `${s(id)}/analytics-settings`)
      ),
    saveAnalyticsSettings: async (id, body) =>
      parseAnalyticsSettings(
        await client.request('PATCH', `${s(id)}/analytics-settings`, body)
      ),
    integrations: async (id) =>
      parseIntegrations(await client.request('GET', `${s(id)}/integrations`)),
    issueSecret: async (id, kind) =>
      parseSecret(
        await client.request('POST', `${s(id)}/integrations/${kind}/secret`)
      ),
    revokeIntegration: (id, kind) =>
      requestVoid(client, 'DELETE', `${s(id)}/integrations/${kind}`),
    createExport: async (id, body) =>
      parseExport(await client.request('POST', `${s(id)}/exports`, body)),
    exports: async (id) =>
      parseExports(await client.request('GET', `${s(id)}/exports`)),
    exportOne: async (id, xid) =>
      parseExport(await client.request('GET', `${s(id)}/exports/${seg(xid)}`)),
    subscription: async (id) =>
      parseSubscription(
        await client.request('GET', `${s(id)}/reports/subscription`)
      ),
    saveSubscription: async (id, body) =>
      parseSubscription(
        await client.request('PATCH', `${s(id)}/reports/subscription`, body)
      ),
  };
}
