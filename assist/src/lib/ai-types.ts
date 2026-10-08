/**
 * Э3-бис «Аналитика с ИИ» — формы ответов кабинета (sites-backend
 * `assist-analytics/ai/ai-cabinet.service.ts`, `exp/experiments.service.ts`).
 * Разбор — `ai-api.ts`.
 */

export const LEAD_BUCKETS = ['hot', 'warm', 'cold'] as const;
export type LeadBucket = (typeof LEAD_BUCKETS)[number];

export const AI_INTENTS = [
  'product_info',
  'price',
  'availability',
  'delivery',
  'payment',
  'returns',
  'order_status',
  'booking',
  'how_to',
  'complaint',
  'wholesale_partnership',
  'job',
  'offtopic_spam',
  'other',
] as const;
export type AiIntent = (typeof AI_INTENTS)[number];

export const AI_STAGES = [
  'explore',
  'compare',
  'decide',
  'post_purchase',
  'support',
] as const;
export type AiStage = (typeof AI_STAGES)[number];

export const AI_OUTCOMES = [
  'resolved',
  'partially',
  'unresolved',
  'handed_off',
  'abandoned',
] as const;

export const AI_FAILURES = [
  'price_too_high',
  'no_delivery_region',
  'out_of_stock',
  'info_not_found',
  'product_mismatch',
  'trust_doubt',
  'payment_method_missing',
  'operator_no_response',
  'assistant_error',
  'just_browsing',
  'other',
] as const;
export type AiFailure = (typeof AI_FAILURES)[number];

export const LEAD_FEATURES = [
  'stage',
  'signals',
  'model',
  'turns',
  'assist_click',
  'page_product',
  'page_cart',
  'voice',
  'repeat_visit',
  'intent',
] as const;
export type LeadFeature = (typeof LEAD_FEATURES)[number];

export const VERTICALS = ['shop', 'services', 'saas', 'other'] as const;
export type Vertical = (typeof VERTICALS)[number];

export interface AiPlanView {
  planId: string | null;
  aiAnalytics: boolean;
  leadCalibration: boolean;
  experiments: boolean;
  linkedWindowDays: number;
  behaviorViewsPerMonth: number;
}

export interface Dist {
  key: string;
  n: number;
}

export interface AiSummaryView {
  plan: AiPlanView;
  model: { ok: boolean; reason: string | null };
  budget: { period: string; capMicroUsd: number; spentMicroUsd: number };
  coverage: {
    closed: number;
    labeled: number;
    failed: number;
    skipped: number;
    injection: number;
    pending: number;
    sampled: boolean;
  };
  buckets: { hot: number; warm: number; cold: number; hotNoLead: number };
  intents: Dist[];
  stages: Dist[];
  outcomes: Dist[];
  failureReasons: Dist[];
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
  status: string;
  intent: string | null;
  stage: string | null;
  outcome: string | null;
  failureReason: string | null;
  leadScore: number | null;
  leadBucket: LeadBucket | null;
  leadProb: number | null;
  features: Array<{ f: LeadFeature; c: number }>;
  intentNote: string | null;
  failureNote: string | null;
  converted: boolean;
  lead: boolean;
  handoff: boolean;
  weight: number;
  overridden: boolean;
}

export interface AiDialogsPage {
  items: AiDialogView[];
  nextCursor: string | null;
}

export const FINDING_CODES = [
  'N2',
  'N3',
  'N4',
  'N5',
  'N6',
  'N7',
  'N8',
  'N10',
] as const;
export type FindingCode = (typeof FINDING_CODES)[number];

export interface FindingView {
  n: number;
  x: number;
  share: number;
  ciLow: number;
  ciHigh: number;
  base: number | null;
  page: string | null;
  topic: string | null;
  reason: string | null;
  field: string | null;
  metric: 'lcp' | 'inp' | 'cls' | null;
  value: number | null;
  trigger: string | null;
}

export interface InsightView {
  id: string;
  code: FindingCode;
  impact: 'high' | 'medium' | 'low';
  finding: FindingView;
  text: { title: string; what: string; action: string } | null;
  textSkipped: string | null;
  status: 'new' | 'done' | 'dismissed';
  doneAt: string | null;
  followUp: {
    before: { share?: number; value?: number | null };
    after: { share?: number; value?: number } | null;
  } | null;
  feedback: 1 | -1 | null;
}

export interface InsightsView {
  weeks: string[];
  weekStart: string | null;
  items: InsightView[];
  plan: AiPlanView;
  model: { ok: boolean; reason: string | null };
}

export const EXPERIMENT_KINDS = ['holdout', 'greeting', 'suggestions'] as const;
export type ExperimentKind = (typeof EXPERIMENT_KINDS)[number];

export interface PowerView {
  units28: number;
  conversions28: number;
  baseRate: number;
  unitsPerDay: number;
  expectedUnits: number;
  mdeRel: number | null;
  minUnitsPerArm: number;
  ok: boolean;
  reason: 'no_traffic' | 'no_conversions' | 'underpowered' | null;
}

export interface ExperimentResultView {
  nA: number;
  nB: number;
  xA: number;
  xB: number;
  rateA: number;
  rateB: number;
  diff: number;
  ciLow: number;
  ciHigh: number;
  p: number | null;
  liftRel: number | null;
  verdict: 'significant' | 'not_significant' | 'insufficient_sample';
  /** Срабатывания цели за срок: всего и «со страницы» (заход 9). */
  goalTrust: { total: number; page: number; pageShare: number | null } | null;
}

export interface ExperimentView {
  id: string;
  kind: ExperimentKind;
  goalKey: string;
  share: number;
  status: 'running' | 'done' | 'invalid' | 'stopped';
  horizonDays: number;
  startedAt: string;
  endsAt: string;
  stopReason: string | null;
  mdeRel: number;
  minUnitsPerArm: number;
  units: { a: number; b: number };
  srmP: number | null;
  result: ExperimentResultView | null;
}

export interface ExperimentRequest {
  kind: ExperimentKind;
  goalKey: string;
  share?: number;
  horizonDays?: number;
  variant?: Record<string, string | string[]> | null;
}

export interface BehaviorPage {
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

export interface BehaviorView {
  enabled: boolean;
  reason: 'plan' | 'settings' | null;
  /** sampleRate: 1 — в квоте; < 1 — выборка сверх неё; 0 — потолок (заход 9). */
  quota: { used: number; limit: number; sampleRate: number };
  pages: BehaviorPage[];
  totalViews: number;
}

/** Настройки Э3-бис внутри `analytics` сайта (частичная правка PATCH). */
export interface AiSettings {
  aiLabeling: boolean;
  vertical: Vertical;
  linked: boolean;
  linkedGcm: boolean;
  linkedWindowDays: number;
  behavior: boolean;
}
