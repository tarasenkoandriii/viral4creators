/**
 * AI Publisher — контракт маршрутов P-E (проектный документ §11.3 «P-E —
 * отчёты, эксперименты, труд, интеграции, бэкап»), по `_template.ts`. Тест
 * `reports/reports-api.spec.ts` сверяет список с контроллером. Суммы —
 * `MinorJson`, даты — ISO, метрики — `Computable<T>` в JSON-виде (bigint —
 * строкой), неизвестное — `null` рядом со статусом.
 */
import { route } from './_template';
import type {
  ListPage,
  MinorJson,
  MutationBody,
  RevisionedBody,
} from './common';
import type { IntegrationKind, IntegrationStatus, PubRole } from './states';

// ── Труд (TimeEntry) ─────────────────────────────────────────────────────

export type TimeCategory =
  | 'setup'
  | 'research'
  | 'production'
  | 'distribution'
  | 'analytics_ops'
  | 'qa_reports'
  | 'development';

export interface TimeEntryView {
  id: string;
  memberId: string;
  memberDisplayName: string;
  role: PubRole | 'admin';
  task: string;
  featureId: string | null;
  contentId: string | null;
  minutes: number;
  /** null — ставка роли не утверждена на момент записи («не менее» в отчёте). */
  rateMinorPerHour: MinorJson | null;
  rateParamVersion: number | null;
  workDate: string;
  category: TimeCategory;
  isInvestment: boolean;
  createdAt: string;
  revision: number;
}
export interface CreateTimeEntryBody extends MutationBody {
  /** Чужая запись — только product_owner (матрица §4.2). */
  memberId?: string;
  role: PubRole | 'admin';
  task: string;
  featureId?: string | null;
  contentId?: string | null;
  minutes: number;
  /** `YYYY-MM-DD` по Kyiv. */
  workDate: string;
  category: TimeCategory;
}
export interface PatchTimeEntryBody extends RevisionedBody {
  task?: string;
  minutes?: number;
  workDate?: string;
  category?: TimeCategory;
  featureId?: string | null;
  contentId?: string | null;
}

// ── Импорт метрик ────────────────────────────────────────────────────────

/** Сутки Kyiv одного источника; другое определение метрики — своё имя в `extra`. */
export interface MetricImportDay {
  date: string;
  page?: string | null;
  sessions?: number | null;
  engagedVisits?: number | null;
  impressions?: number | null;
  clicks?: number | null;
  indexed?: boolean | null;
  partial?: boolean;
  extra?: Record<string, number | null>;
}
export interface CreateMetricImportBody extends MutationBody {
  source: 'search_console' | 'web_analytics' | 'manual';
  periodStart: string;
  periodEnd: string;
  payload: { days: MetricImportDay[]; definitions?: Record<string, string> };
  fileRef?: string | null;
  note?: string | null;
}
export interface MetricImportView {
  id: string;
  source: string;
  periodStart: string;
  periodEnd: string;
  granularity: 'kyiv_day';
  days: number;
  importedBy: string;
  importedAt: string;
  fileRef: string | null;
  note: string | null;
}

// ── Интеграции ───────────────────────────────────────────────────────────

export interface IntegrationView {
  kind: IntegrationKind;
  /** Строки ещё нет — `disconnected` и `exists:false` (не «подключено»). */
  exists: boolean;
  status: IntegrationStatus;
  manual: boolean;
  lastSuccessAt: string | null;
  lastCheckedAt: string | null;
  staleAfterHours: number;
  /** connected, но последняя успешная синхронизация старше staleAfterHours. */
  stale: boolean;
  note: string | null;
  revision: number | null;
}
export interface PutIntegrationBody extends MutationBody {
  status: IntegrationStatus;
  /** Для существующей строки — обязательна (CAS). */
  expectedRevision?: number;
  note?: string | null;
  staleAfterHours?: number;
  /** Момент последней успешной синхронизации (ручная проверка); по умолчанию — сейчас при `connected`. */
  lastSuccessAt?: string | null;
}

// ── Эксперименты F17 ─────────────────────────────────────────────────────

export interface ExperimentView {
  id: string;
  key: string;
  version: number;
  kind: 'pilot' | 'change';
  hypothesis: string;
  change: string;
  metric: string;
  expectedSignal: string;
  stopConditions: string;
  baselineVersionId: string | null;
  newVersionId: string | null;
  windowStart: string;
  windowEnd: string;
  limitMinor: MinorJson | null;
  thresholds: unknown;
  t0Planned: string | null;
  t0: string | null;
  t42: string | null;
  t72: string | null;
  t90: string | null;
  lateCohortEnd: string | null;
  registeredAt: string;
  appliedAt: string | null;
  status: 'registered' | 'running' | 'concluded' | 'cancelled' | 'superseded';
  conclusion: 'supported' | 'not_supported' | 'inconclusive' | null;
  conclusionReason: string | null;
  decision: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  supersedesId: string | null;
  contentIds: string[];
}
export interface RegisterExperimentBody extends MutationBody {
  key: string;
  hypothesis: string;
  change: string;
  metric: string;
  expectedSignal: string;
  stopConditions: string;
  baselineVersionId?: string | null;
  newVersionId?: string | null;
  /** Не раньше регистрации (гипотеза — до запуска, ТЗ §23). */
  windowStart: string;
  windowEnd: string;
  limitMinor?: MinorJson | null;
  contentIds?: string[];
}
export type NewExperimentVersionBody = MutationBody &
  Partial<Omit<RegisterExperimentBody, 'opKey' | 'key'>> & {
    lateCohortEnd?: string | null;
  };
export interface ConcludeExperimentBody extends MutationBody {
  conclusion: 'supported' | 'not_supported' | 'inconclusive';
  reason: string;
  decision:
    | 'continue_limited'
    | 'fix_stage'
    | 'stop_purchases'
    | 'test_external_order'
    | 'scale';
}

// ── Отчёты ───────────────────────────────────────────────────────────────

export type ReportKindApi =
  'weekly' | 'd42' | 'd72' | 'd90' | 'late_cohort' | 'ad_hoc';

export interface ReportSummaryView {
  id: string;
  kind: ReportKindApi;
  periodStart: string;
  periodEnd: string;
  snapshotAt: string;
  experimentId: string | null;
  inputsHash: string;
  supersedesReportId: string | null;
  recomputeReason: string | null;
  decision: string | null;
  /** Есть наследник (пересчёт или решение) — это не последняя версия. */
  superseded: boolean;
  createdAt: string;
  createdBy: string;
}
export interface ReportView extends ReportSummaryView {
  cohort: unknown;
  attributionModel: 'last_non_direct_30d';
  sources: unknown;
  metrics: unknown;
  costs: unknown;
  assumptions: string | null;
}
export interface CreateReportBody extends MutationBody {
  kind: ReportKindApi;
  periodStart?: string;
  periodEnd?: string;
  snapshotAt?: string;
  experimentId?: string;
}
export interface ReportDecisionBody extends MutationBody {
  decision: string;
}
export interface RecomputeReportBody extends MutationBody {
  /**
   * Человек пересчитывает только «вручную»; `late_decision|late_payment|
   * identity_change` ставит задание `report-staleness` (иначе 400
   * `system_only`, аудит P-E S3-10).
   */
  reason?: 'manual';
}
export interface EconomicsPreview {
  preliminary: true;
  at: string;
  kind: ReportKindApi;
  cohort: unknown;
  sources: unknown;
  metrics: unknown;
  costs: unknown;
}

// ── Копии и восстановление ───────────────────────────────────────────────

export interface BackupView {
  id: string;
  kind: 'weekly' | 'post_purchase' | 'manual';
  status: 'ok' | 'failed' | 'expired_deleted';
  sha256: string;
  sizeBytes: MinorJson;
  tableCounts: Record<string, number>;
  keyVersion: string;
  rotationUntil: string;
  createdAt: string;
  createdBy: string;
}
export interface CreateBackupBody extends MutationBody {
  kind: 'manual';
}
export interface RestoreBody extends MutationBody {
  mode: 'dry_run' | 'apply_new_product';
  /** Для apply: тестовый сайт ТОГО ЖЕ кабинета без продукта (§15.4). */
  targetSiteId?: string;
}
export interface RestoreView {
  id: string;
  backupId: string;
  mode: 'dry_run' | 'apply_new_product';
  targetProductId: string | null;
  status: 'running' | 'done' | 'failed';
  report: unknown;
  startedBy: string;
  createdAt: string;
  updatedAt: string;
}

export const REPORTS_ROUTES = {
  listTimeEntries: route<void, ListPage<TimeEntryView>>({
    method: 'GET',
    path: '/publisher/products/:pid/time-entries',
    action: ['time.own', 'time.others'],
    mutation: false,
    status: 200,
  }),
  createTimeEntry: route<CreateTimeEntryBody, TimeEntryView>({
    method: 'POST',
    path: '/publisher/products/:pid/time-entries',
    action: ['time.own', 'time.others'],
    mutation: true,
    status: 201,
  }),
  patchTimeEntry: route<PatchTimeEntryBody, TimeEntryView>({
    method: 'PATCH',
    path: '/publisher/products/:pid/time-entries/:id',
    action: ['time.own', 'time.others'],
    mutation: true,
    status: 200,
  }),
  listMetricImports: route<void, ListPage<MetricImportView>>({
    method: 'GET',
    path: '/publisher/products/:pid/metric-imports',
    action: 'metrics.import',
    mutation: false,
    status: 200,
  }),
  createMetricImport: route<CreateMetricImportBody, MetricImportView>({
    method: 'POST',
    path: '/publisher/products/:pid/metric-imports',
    action: 'metrics.import',
    mutation: true,
    status: 201,
  }),
  listIntegrations: route<void, { items: IntegrationView[] }>({
    method: 'GET',
    path: '/publisher/products/:pid/integrations',
    action: 'metrics.import',
    mutation: false,
    status: 200,
  }),
  putIntegration: route<PutIntegrationBody, IntegrationView>({
    method: 'PUT',
    path: '/publisher/products/:pid/integrations/:kind',
    action: 'metrics.import',
    mutation: true,
    status: 200,
  }),
  listExperiments: route<void, { items: ExperimentView[] }>({
    method: 'GET',
    path: '/publisher/products/:pid/experiments',
    action: 'product.read',
    mutation: false,
    status: 200,
  }),
  registerExperiment: route<RegisterExperimentBody, ExperimentView>({
    method: 'POST',
    path: '/publisher/products/:pid/experiments',
    action: 'experiment.register',
    mutation: true,
    status: 201,
  }),
  newExperimentVersion: route<NewExperimentVersionBody, ExperimentView>({
    method: 'POST',
    path: '/publisher/products/:pid/experiments/:id/version',
    action: 'experiment.register',
    mutation: true,
    status: 201,
  }),
  applyExperiment: route<MutationBody, ExperimentView>({
    method: 'POST',
    path: '/publisher/products/:pid/experiments/:id/apply',
    action: 'experiment.register',
    mutation: true,
    status: 200,
  }),
  concludeExperiment: route<ConcludeExperimentBody, ExperimentView>({
    method: 'POST',
    path: '/publisher/products/:pid/experiments/:id/conclude',
    action: 'experiment.conclude',
    mutation: true,
    status: 200,
  }),
  createReport: route<CreateReportBody, ReportView>({
    method: 'POST',
    path: '/publisher/products/:pid/reports',
    action: 'report.manage',
    mutation: true,
    status: 201,
  }),
  listReports: route<void, ListPage<ReportSummaryView>>({
    method: 'GET',
    path: '/publisher/products/:pid/reports',
    action: 'product.read',
    mutation: false,
    status: 200,
  }),
  getReport: route<void, ReportView>({
    method: 'GET',
    path: '/publisher/products/:pid/reports/:id',
    action: 'product.read',
    mutation: false,
    status: 200,
  }),
  reportDecision: route<ReportDecisionBody, ReportView>({
    method: 'POST',
    path: '/publisher/products/:pid/reports/:id/decision',
    action: 'report.manage',
    mutation: true,
    status: 201,
  }),
  recomputeReport: route<RecomputeReportBody, ReportView>({
    method: 'POST',
    path: '/publisher/products/:pid/reports/:id/recompute',
    action: 'report.manage',
    mutation: true,
    status: 201,
  }),
  economicsPreview: route<void, EconomicsPreview>({
    method: 'GET',
    path: '/publisher/products/:pid/economics/preview',
    action: 'report.manage',
    mutation: false,
    status: 200,
  }),
  listBackups: route<void, { items: BackupView[] }>({
    method: 'GET',
    path: '/publisher/products/:pid/backups',
    action: 'backup.manage',
    mutation: false,
    status: 200,
  }),
  createBackup: route<CreateBackupBody, BackupView>({
    method: 'POST',
    path: '/publisher/products/:pid/backups',
    action: 'backup.manage',
    mutation: true,
    status: 201,
  }),
  restoreBackup: route<RestoreBody, RestoreView>({
    method: 'POST',
    path: '/publisher/products/:pid/backups/:id/restore',
    action: ['restore.dry_run', 'restore.apply'],
    mutation: true,
    status: 201,
  }),
  getRestore: route<void, RestoreView>({
    method: 'GET',
    path: '/publisher/products/:pid/restores/:id',
    action: ['backup.manage', 'restore.apply'],
    mutation: false,
    status: 200,
  }),
} as const;
