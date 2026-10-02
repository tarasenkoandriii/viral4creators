/**
 * Цели, статистика, экспорт, интеграции (Э3, сервер — агент A) — повтор
 * `sites-backend/src/modules/assist-analytics/{api-types,goal-types,
 * analytics-config}.ts` (`scripts/e3-api.test.ts` сверяет перечни и поля).
 * Числа считает код по свёрткам; TMA их только показывает.
 *
 * Слова атрибуции — строго §5-тер.2: «помощник довёл» (direct), «с
 * участием помощника (не обязательно благодаря)» (assisted).
 */

export const GOAL_TEMPLATES = [
  'lead',
  'purchase',
  'call',
  'booking',
  'subscribe',
  'messenger',
  'custom',
] as const;
export type GoalTemplate = (typeof GOAL_TEMPLATES)[number];

export const GOAL_KEY = /^[a-z0-9_-]{1,40}$/;
export const GOAL_LIMITS = {
  perSite: 30,
  detectorsPerGoal: 5,
  nameChars: 60,
} as const;

export interface ElementDescriptor {
  assistGoal: string | null;
  assistId: string | null;
  role: string | null;
  text: string | null;
  tag: string | null;
}

export type GoalDetector =
  | { kind: 'url'; config: { pathMask: string; fromPathMask: string | null } }
  | {
      kind: 'click';
      config: { descriptor: ElementDescriptor; pathMask: string | null };
    }
  | { kind: 'click'; config: { auto: 'tel' | 'messenger' } }
  | {
      kind: 'form_submit';
      config: { descriptor: ElementDescriptor; pathMask: string | null };
    }
  | { kind: 'js'; config: Record<string, never> }
  | { kind: 'builtin'; config: { event: 'lead' } }
  | { kind: 's2s'; config: Record<string, never> }
  | { kind: 'crm'; config: { provider: 'woocommerce' } };

export const DETECTOR_KINDS = [
  'url',
  'click',
  'form_submit',
  'js',
  'builtin',
  's2s',
  'crm',
] as const;
export type DetectorKind = (typeof DETECTOR_KINDS)[number];

export const GOAL_TRUSTS = ['verified', 'builtin', 'page'] as const;
export type GoalTrust = (typeof GOAL_TRUSTS)[number];
export const GOAL_ATTRIBUTIONS = [
  'direct',
  'assisted',
  'unassisted',
  'unknown',
] as const;
export type GoalAttribution = (typeof GOAL_ATTRIBUTIONS)[number];

export const VALUE_MODES = ['none', 'fixed', 'event'] as const;
export type ValueMode = (typeof VALUE_MODES)[number];

export interface GoalInput {
  key: string;
  template: GoalTemplate;
  name: string;
  detectors: GoalDetector[];
  valueMode: ValueMode;
  fixedValue: number | null;
  currency: string | null;
}

export interface GoalView {
  id: string;
  key: string;
  template: GoalTemplate;
  name: string;
  detectors: GoalDetector[];
  valueMode: ValueMode;
  fixedValue: number | null;
  currency: string | null;
  status: 'active' | 'paused' | 'stale';
  lastFiredAt: string | null;
  createdAt: string;
}

export interface GoalPickerTokenView {
  tokenId: string;
  url: string;
  expiresAt: string;
}

export interface GoalPickerStatusView {
  status: 'waiting' | 'picked' | 'expired';
  result: {
    descriptor: ElementDescriptor;
    path: string;
    label: string;
    kind: 'click' | 'form_submit';
  } | null;
}

export interface GoalRecentEventView {
  id: string;
  occurredAt: string;
  source: string;
  trust: GoalTrust;
  attribution: GoalAttribution;
  path: string | null;
  orderId: string | null;
  value: number | null;
  currency: string | null;
  status: 'completed' | 'refunded' | 'cancelled';
}

export interface MetricView {
  value: number;
  prev: number | null;
  deltaPct: number | null;
  noise: boolean | null;
}

export interface StatsPeriod {
  from: string;
  to: string;
  attributionWindowOpenFrom: string | null;
  timezone: string;
}

export interface StatsOverviewView {
  period: StatsPeriod;
  dialogs: MetricView;
  resolved: MetricView;
  resolvedShare: MetricView;
  operatorHoursSaved: number;
  minutesPerQuestion: number;
  handoffs: MetricView;
  handoffsMissed: MetricView;
  leads: MetricView;
  conversions: { total: MetricView; direct: MetricView; assisted: MetricView };
  thumbsUpShare: MetricView;
  costMicroUsd: number;
  series: Array<{
    day: string;
    dialogs: number;
    resolved: number;
    handoffs: number;
    leads: number;
    conversions: number;
  }>;
}

export interface StatsConversionsView {
  period: StatsPeriod;
  goals: Array<{
    goalId: string;
    key: string;
    name: string;
    total: number;
    direct: number;
    assisted: number;
    unassisted: number;
    refunds: number;
    value: { verified: number; page: number; currency: string | null };
    dialogConversion: number | null;
  }>;
  proactive: Array<{
    key: string;
    shown: number;
    accepted: number;
    dismissed: number;
    dialogs: number;
    conversions: number;
  }>;
}

export interface StatsTopicsView {
  period: StatsPeriod;
  topics: Array<{
    clusterId: string;
    label: string;
    kind: string;
    distinctVisitors: number;
    dialogs: number;
    conversions: number;
    unknownShare: number;
    status: 'open' | 'resolved' | 'ignored';
  }>;
  uncovered: number;
}

export interface StatsSitesView {
  sites: Array<{
    siteId: string;
    name: string;
    dialogs: number;
    resolvedShare: number | null;
    conversions: number;
    costMicroUsd: number;
  }>;
}

export interface IntegrationsView {
  goalWebhook: {
    active: boolean;
    createdAt: string | null;
    lastUsedAt: string | null;
    endpoint: string;
  };
  identity: { active: boolean; createdAt: string | null };
}

export interface SecretIssuedView {
  kind: 'goal_webhook' | 'identity';
  secret: string;
  createdAt: string;
}

export const EXPORT_KINDS = ['daily', 'conversions', 'dialogs'] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];

export interface ExportRequest {
  kind: ExportKind;
  from: string;
  to: string;
  withText?: boolean;
}

export const EXPORT_STATUSES = [
  'queued',
  'running',
  'done',
  'failed',
  'expired',
] as const;

export interface ExportView {
  id: string;
  kind: ExportKind;
  status: (typeof EXPORT_STATUSES)[number];
  rows: number | null;
  url: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export interface ReportSubscriptionView {
  weekly: boolean;
  digest: boolean;
}

export interface AnalyticsConfig {
  schema: 1;
  minutesPerQuestion: number;
  officeCidrs: string[];
  excludedPaths: string[];
}

export interface AnalyticsSettingsView {
  config: AnalyticsConfig;
  timezone: string;
  currency: string;
}

export const ANALYTICS_ERROR_CODES = [
  'GOAL_INVALID',
  'GOAL_NOT_FOUND',
  'GOAL_LIMIT',
  'GOAL_KEY_TAKEN',
  'PICKER_EXPIRED',
  'HOST_NOT_VERIFIED',
  'STATS_RANGE_INVALID',
  'EXPORT_FORBIDDEN',
  'EXPORT_NOT_FOUND',
  'ANALYTICS_CONFIG_INVALID',
  'INTEGRATION_NOT_FOUND',
  'SIGNATURE_INVALID',
  'IDEMPOTENCY_KEY_REQUIRED',
  'WEBHOOK_BODY_INVALID',
] as const;
export type AnalyticsErrorCode = (typeof ANALYTICS_ERROR_CODES)[number];
