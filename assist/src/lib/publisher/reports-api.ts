/**
 * AI Publisher (P-G2): клиент маршрутов P-E — учёт часов, импорт метрик,
 * интеграции, эксперименты F17, отчёты-снимки, предварительная экономика,
 * копии и восстановление (контракт
 * `sites-backend/src/modules/publisher/contracts/reports-api.ts`).
 *
 * `ReportView.metrics/costs/sources/cohort` в контракте — `unknown`
 * (снимок хранится JSON как есть, форма — `reports/metrics/report-compute.ts`).
 * Разбор ниже терпим к отсутствующим частям старых снимков (часть → null,
 * экран пишет «в знімку немає»), но строг к форме `Computable`: ноль не
 * подставляется ни вместо «не вычисляется», ни вместо отсутствующего.
 */
import type { PublisherHttp } from './common-api';
import {
  arr,
  bad,
  bool,
  choice,
  choiceN,
  completeness,
  computable,
  int,
  intN,
  items,
  minor,
  minorN,
  num,
  obj,
  page,
  productPath,
  seg,
  verbs,
  str,
  strList,
  strN,
  type Computable,
  type Completeness,
  type Rec as Obj,
} from './ops-decode';

// ── Перечни (зеркало contracts/states.ts и reports-api.ts) ───────────────

export const PUB_ROLES = [
  'product_owner',
  'editor',
  'operator',
  'analyst',
  'sales',
  'viewer',
] as const;
export const TIME_ENTRY_ROLES = [...PUB_ROLES, 'admin'] as const;
export const TIME_ENTRY_CATEGORIES = [
  'setup',
  'research',
  'production',
  'distribution',
  'analytics_ops',
  'qa_reports',
  'development',
] as const;
export const INTEGRATION_KINDS = [
  'events_collector',
  'web_analytics',
  'search_console',
  'crm_registry',
  'ai_provider',
  'cms',
] as const;
export const INTEGRATION_STATUSES = [
  'connected',
  'degraded',
  'disconnected',
] as const;
export const METRIC_IMPORT_SOURCES = [
  'search_console',
  'web_analytics',
  'manual',
] as const;
export const EXPERIMENT_KINDS = ['pilot', 'change'] as const;
export const EXPERIMENT_STATUSES = [
  'registered',
  'running',
  'concluded',
  'cancelled',
  'superseded',
] as const;
export const EXPERIMENT_CONCLUSIONS = [
  'supported',
  'not_supported',
  'inconclusive',
] as const;
export const EXPERIMENT_DECISIONS = [
  'continue_limited',
  'fix_stage',
  'stop_purchases',
  'test_external_order',
  'scale',
] as const;
export const REPORT_KINDS = [
  'weekly',
  'd42',
  'd72',
  'd90',
  'late_cohort',
  'ad_hoc',
] as const;
export const REPORT_RECOMPUTE_REASONS = [
  'late_decision',
  'late_payment',
  'identity_change',
  'manual',
  'decision',
] as const;
/**
 * Причина пересчёта, которую выбирает человек: только `manual` (P-E
 * S3-10, Р-PUB-E-25); прочие ставит задание `report-staleness`, сервер
 * отвергает их от человека (400 `reason: system_only`).
 */
export const RECOMPUTE_REASONS_MANUAL = ['manual'] as const;
export const BACKUP_KINDS = ['weekly', 'post_purchase', 'manual'] as const;
export const BACKUP_STATUSES = ['ok', 'failed', 'expired_deleted'] as const;
export const RESTORE_MODES = ['dry_run', 'apply_new_product'] as const;
export const RESTORE_STATUSES = ['running', 'done', 'failed'] as const;
export const VERDICTS = ['met', 'not_met', 'inconclusive'] as const;
export const VERDICT_PARTS = ['met', 'not_met', 'unknown'] as const;
export const WINDOW_STATES = ['not_published', 'open', 'closed'] as const;

export type PubRole = (typeof PUB_ROLES)[number];
export type TimeRole = (typeof TIME_ENTRY_ROLES)[number];
export type TimeCategory = (typeof TIME_ENTRY_CATEGORIES)[number];
export type IntegrationKind = (typeof INTEGRATION_KINDS)[number];
export type IntegrationStatus = (typeof INTEGRATION_STATUSES)[number];
export type ExperimentStatus = (typeof EXPERIMENT_STATUSES)[number];
export type ExperimentConclusion = (typeof EXPERIMENT_CONCLUSIONS)[number];
export type ExperimentDecision = (typeof EXPERIMENT_DECISIONS)[number];
export type ReportKind = (typeof REPORT_KINDS)[number];
export type RecomputeReason = (typeof REPORT_RECOMPUTE_REASONS)[number];
export type Verdict = (typeof VERDICTS)[number];
export type VerdictPart = (typeof VERDICT_PARTS)[number];
export type WindowState = (typeof WINDOW_STATES)[number];

// ── Виды ─────────────────────────────────────────────────────────────────

export interface TimeEntryView {
  id: string;
  memberId: string;
  memberDisplayName: string;
  role: TimeRole;
  task: string;
  featureId: string | null;
  contentId: string | null;
  minutes: number;
  /** null — ставка роли не утверждена («не менее» в отчёте). */
  rateMinorPerHour: string | null;
  rateParamVersion: number | null;
  workDate: string;
  category: TimeCategory;
  isInvestment: boolean;
  createdAt: string;
  revision: number;
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
export interface IntegrationView {
  kind: IntegrationKind;
  exists: boolean;
  status: IntegrationStatus;
  manual: boolean;
  lastSuccessAt: string | null;
  lastCheckedAt: string | null;
  staleAfterHours: number;
  stale: boolean;
  note: string | null;
  revision: number | null;
}
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
  limitMinor: string | null;
  thresholds: unknown;
  t0Planned: string | null;
  t0: string | null;
  t42: string | null;
  t72: string | null;
  t90: string | null;
  lateCohortEnd: string | null;
  registeredAt: string;
  appliedAt: string | null;
  status: ExperimentStatus;
  conclusion: ExperimentConclusion | null;
  conclusionReason: string | null;
  decision: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  supersedesId: string | null;
  contentIds: string[];
}
export interface ReportSummaryView {
  id: string;
  kind: ReportKind;
  periodStart: string;
  periodEnd: string;
  snapshotAt: string;
  experimentId: string | null;
  inputsHash: string;
  supersedesReportId: string | null;
  recomputeReason: string | null;
  decision: string | null;
  superseded: boolean;
  createdAt: string;
  createdBy: string;
}

/** Источник данных отчёта (`sources.integrations[]`). */
export interface ReportSource {
  kind: string;
  status: IntegrationStatus;
  manual: boolean;
  lastSyncedAt: string | null;
  stale: boolean;
}
export type MoneyC = Computable<string>;
export interface ReportMetrics {
  sessions: {
    mode: string;
    value: number | null;
    /**
     * Сессии полные (сборщик подключён и свеж к концу периода, P-E S2-3);
     * `null` — снимок до поправки (неизвестно).
     */
    complete: boolean | null;
    partialDays: string[];
    missingDays: string[];
  } | null;
  leads: {
    inPeriod: number;
    linked: number;
    pending: number;
    qualifiedUnique: number;
    linkedQualified: number;
    unknownQualified: number;
    coverage: Computable<number>;
    proposalsToDistinct: number;
    /**
     * Заявки известных сессий вне когорты (P-E S1-2): сессия в следующем
     * периоде / заявка позже окна своей сессии; `null` — старый снимок.
     */
    outsideCohort: { nextPeriod: number; afterSessionWindow: number } | null;
  } | null;
  qualifiedPer100Sessions: {
    basis: string;
    value: Computable<number>;
  } | null;
  windowClosed: boolean | null;
  signalD42: {
    verdict: Verdict;
    parts: Record<
      'sessions' | 'qualified' | 'proposals',
      { value: number | null; threshold: number; state: VerdictPart }
    >;
  } | null;
  searchSignalD90: {
    verdict: Verdict;
    parts: Record<string, VerdictPart>;
  } | null;
  economics: {
    directCpl: MoneyC;
    fullOperationalCplTechnical: MoneyC;
    productCpl: MoneyC;
    investmentCpl: MoneyC;
    allowedOperationalCpl: MoneyC;
    economicSignal: Computable<'within' | 'above'>;
    operationalCac: MoneyC;
    investmentCac: MoneyC;
    newPayingLinked: number;
    newCustomerUnknown: number;
    cacWindowEnd: string | null;
  } | null;
  revenue: {
    byCurrency: Record<
      string,
      { receivedMinor: string; refundedMinor: string; netMinor: string }
    >;
    externalPayingProspects: number;
    contractsSigned: number;
    excludedNonExternal: number;
    commercialValidation: 'confirmed' | 'not_confirmed';
  } | null;
  placements: Array<{
    id: string;
    placementCode: string;
    publishedAt: string | null;
    windowState: WindowState;
    late: boolean;
    deliveredMinor: string;
    /** Обязательство/оплата больше «оказано» (P-E S2-4); `null` — старый снимок. */
    deliveryUnconfirmed: boolean | null;
    technicalQualified: number;
    directCpl: MoneyC;
  }>;
  experimentConclusion: 'any' | 'inconclusive_only' | null;
  diagnostics: Record<string, number> | null;
}
export interface ReportCosts {
  currency: string | null;
  operational: MoneyC | null;
  investment: MoneyC | null;
  total: MoneyC | null;
  cashNetPaidMinor: string | null;
  advancesMinor: string | null;
  minutesWithoutRate: { operational: number; investment: number } | null;
  aiCallsUnpriced: number | null;
  parts: Record<string, string>;
}
export interface ReportCohort {
  t0: string | null;
  t42: string | null;
  start: string | null;
  end: string | null;
  closeAt: string | null;
  lateCohortEnd: string | null;
  sessionMode: string | null;
}
export interface ReportView extends ReportSummaryView {
  cohort: ReportCohort;
  attributionModel: 'last_non_direct_30d';
  sources: { list: ReportSource[]; completeness: Completeness | null };
  metrics: ReportMetrics;
  costs: ReportCosts;
  assumptions: string | null;
}
export interface EconomicsPreview {
  preliminary: true;
  at: string;
  kind: ReportKind;
  cohort: ReportCohort;
  sources: ReportView['sources'];
  metrics: ReportMetrics;
  costs: ReportCosts;
}
export interface BackupView {
  id: string;
  kind: (typeof BACKUP_KINDS)[number];
  status: (typeof BACKUP_STATUSES)[number];
  sha256: string;
  sizeBytes: string;
  tableCounts: Record<string, number>;
  keyVersion: string;
  rotationUntil: string;
  createdAt: string;
  createdBy: string;
}
export interface RestoreView {
  id: string;
  backupId: string;
  mode: (typeof RESTORE_MODES)[number];
  targetProductId: string | null;
  status: (typeof RESTORE_STATUSES)[number];
  report: unknown;
  startedBy: string;
  createdAt: string;
  updatedAt: string;
}

// ── Декодеры ─────────────────────────────────────────────────────────────

export function decodeTimeEntry(v: unknown): TimeEntryView {
  const o = obj(v, 'timeEntry');
  return {
    id: str(o.id),
    memberId: str(o.memberId),
    memberDisplayName: str(o.memberDisplayName),
    role: choice(o.role, TIME_ENTRY_ROLES, 'time.role'),
    task: str(o.task),
    featureId: strN(o.featureId),
    contentId: strN(o.contentId),
    minutes: int(o.minutes),
    rateMinorPerHour: minorN(o.rateMinorPerHour),
    rateParamVersion: intN(o.rateParamVersion),
    workDate: str(o.workDate),
    category: choice(o.category, TIME_ENTRY_CATEGORIES, 'time.category'),
    isInvestment: bool(o.isInvestment),
    createdAt: str(o.createdAt),
    revision: int(o.revision),
  };
}

export function decodeMetricImport(v: unknown): MetricImportView {
  const o = obj(v, 'metricImport');
  return {
    id: str(o.id),
    source: str(o.source),
    periodStart: str(o.periodStart),
    periodEnd: str(o.periodEnd),
    granularity: choice(o.granularity, ['kyiv_day'] as const, 'granularity'),
    days: int(o.days),
    importedBy: str(o.importedBy),
    importedAt: str(o.importedAt),
    fileRef: strN(o.fileRef),
    note: strN(o.note),
  };
}

export function decodeIntegration(v: unknown): IntegrationView {
  const o = obj(v, 'integration');
  return {
    kind: choice(o.kind, INTEGRATION_KINDS, 'integration.kind'),
    exists: bool(o.exists),
    status: choice(o.status, INTEGRATION_STATUSES, 'integration.status'),
    manual: bool(o.manual),
    lastSuccessAt: strN(o.lastSuccessAt),
    lastCheckedAt: strN(o.lastCheckedAt),
    staleAfterHours: int(o.staleAfterHours),
    stale: bool(o.stale),
    note: strN(o.note),
    revision: intN(o.revision),
  };
}

export function decodeExperiment(v: unknown): ExperimentView {
  const o = obj(v, 'experiment');
  return {
    id: str(o.id),
    key: str(o.key),
    version: int(o.version),
    kind: choice(o.kind, EXPERIMENT_KINDS, 'experiment.kind'),
    hypothesis: str(o.hypothesis),
    change: str(o.change),
    metric: str(o.metric),
    expectedSignal: str(o.expectedSignal),
    stopConditions: str(o.stopConditions),
    baselineVersionId: strN(o.baselineVersionId),
    newVersionId: strN(o.newVersionId),
    windowStart: str(o.windowStart),
    windowEnd: str(o.windowEnd),
    limitMinor: minorN(o.limitMinor),
    thresholds: o.thresholds ?? null,
    t0Planned: strN(o.t0Planned),
    t0: strN(o.t0),
    t42: strN(o.t42),
    t72: strN(o.t72),
    t90: strN(o.t90),
    lateCohortEnd: strN(o.lateCohortEnd),
    registeredAt: str(o.registeredAt),
    appliedAt: strN(o.appliedAt),
    status: choice(o.status, EXPERIMENT_STATUSES, 'experiment.status'),
    conclusion: choiceN(o.conclusion, EXPERIMENT_CONCLUSIONS, 'conclusion'),
    conclusionReason: strN(o.conclusionReason),
    decision: strN(o.decision),
    decidedBy: strN(o.decidedBy),
    decidedAt: strN(o.decidedAt),
    supersedesId: strN(o.supersedesId),
    contentIds: strList(o.contentIds ?? []),
  };
}

export function decodeReportSummary(v: unknown): ReportSummaryView {
  const o = obj(v, 'report');
  return {
    id: str(o.id),
    kind: choice(o.kind, REPORT_KINDS, 'report.kind'),
    periodStart: str(o.periodStart),
    periodEnd: str(o.periodEnd),
    snapshotAt: str(o.snapshotAt),
    experimentId: strN(o.experimentId),
    inputsHash: str(o.inputsHash),
    supersedesReportId: strN(o.supersedesReportId),
    recomputeReason: strN(o.recomputeReason),
    decision: strN(o.decision),
    superseded: bool(o.superseded),
    createdAt: str(o.createdAt),
    createdBy: str(o.createdBy),
  };
}

const money = (x: unknown) => minor(x, 'money');
const count = (x: unknown) => num(x, 'count');
const opt = (o: Obj, k: string): Obj | null =>
  o[k] === null || o[k] === undefined ? null : obj(o[k], k);

function decodeSources(v: unknown): ReportView['sources'] {
  if (v === null || v === undefined) return { list: [], completeness: null };
  const o = obj(v, 'sources');
  return {
    list: arr(o.integrations ?? [], 'sources.integrations').map((x) => {
      const s = obj(x, 'source');
      return {
        kind: str(s.kind),
        status: choice(s.status, INTEGRATION_STATUSES, 'source.status'),
        manual: bool(s.manual),
        lastSyncedAt: strN(s.lastSyncedAt),
        stale: bool(s.stale),
      };
    }),
    completeness:
      o.completeness === undefined || o.completeness === null
        ? null
        : completeness(o.completeness),
  };
}

export function decodeMetrics(v: unknown): ReportMetrics {
  const o = obj(v ?? {}, 'metrics');
  const s = opt(o, 'sessions');
  const l = opt(o, 'leads');
  const q = opt(o, 'qualifiedPer100Sessions');
  const d42 = opt(o, 'signalD42');
  const d90 = opt(o, 'searchSignalD90');
  const e = opt(o, 'economics');
  const r = opt(o, 'revenue');
  const dg = opt(o, 'diagnostics');
  const part = (p: unknown) => {
    const x = obj(p, 'signal.part');
    return {
      value: x.value === null ? null : count(x.value),
      threshold: count(x.threshold),
      state: choice(x.state, VERDICT_PARTS, 'signal.state'),
    };
  };
  return {
    sessions: s
      ? {
          mode: str(s.mode),
          value: s.value === null ? null : int(s.value),
          complete:
            s.complete === undefined || s.complete === null
              ? null
              : bool(s.complete),
          partialDays: strList(s.partialDays ?? []),
          missingDays: strList(s.missingDays ?? []),
        }
      : null,
    leads: l
      ? {
          inPeriod: int(l.inPeriod),
          linked: int(l.linked),
          pending: int(l.pending),
          qualifiedUnique: int(l.qualifiedUnique),
          linkedQualified: int(l.linkedQualified),
          unknownQualified: int(l.unknownQualified),
          coverage: computable(l.coverage, count, 'coverage'),
          proposalsToDistinct: int(l.proposalsToDistinct),
          outsideCohort: (() => {
            const oc = opt(l, 'outsideCohort');
            return oc
              ? {
                  nextPeriod: int(oc.nextPeriod),
                  afterSessionWindow: int(oc.afterSessionWindow),
                }
              : null;
          })(),
        }
      : null,
    qualifiedPer100Sessions: q
      ? { basis: str(q.basis), value: computable(q.value, count, 'q100') }
      : null,
    windowClosed:
      o.windowClosed === undefined || o.windowClosed === null
        ? null
        : bool(o.windowClosed),
    signalD42: d42
      ? {
          verdict: choice(d42.verdict, VERDICTS, 'd42.verdict'),
          parts: (() => {
            const p = obj(d42.parts, 'd42.parts');
            return {
              sessions: part(p.sessions),
              qualified: part(p.qualified),
              proposals: part(p.proposals),
            };
          })(),
        }
      : null,
    searchSignalD90: d90
      ? {
          verdict: choice(d90.verdict, VERDICTS, 'd90.verdict'),
          parts: Object.fromEntries(
            Object.entries(obj(d90.parts, 'd90.parts')).map(([k, x]) => [
              k,
              choice(x, VERDICT_PARTS, 'd90.part'),
            ])
          ),
        }
      : null,
    economics: e
      ? {
          directCpl: computable(e.directCpl, money, 'directCpl'),
          fullOperationalCplTechnical: computable(
            e.fullOperationalCplTechnical,
            money,
            'opCpl'
          ),
          productCpl: computable(e.productCpl, money, 'productCpl'),
          investmentCpl: computable(e.investmentCpl, money, 'investmentCpl'),
          allowedOperationalCpl: computable(
            e.allowedOperationalCpl,
            money,
            'allowedCpl'
          ),
          economicSignal: computable(
            e.economicSignal,
            (x) => choice(x, ['within', 'above'] as const, 'economicSignal'),
            'economicSignal'
          ),
          operationalCac: computable(e.operationalCac, money, 'opCac'),
          investmentCac: computable(e.investmentCac, money, 'invCac'),
          newPayingLinked: int(e.newPayingLinked ?? 0),
          newCustomerUnknown: int(e.newCustomerUnknown ?? 0),
          cacWindowEnd: strN(e.cacWindowEnd),
        }
      : null,
    revenue: r
      ? {
          byCurrency: Object.fromEntries(
            Object.entries(obj(r.byCurrency ?? {}, 'revenue.byCurrency')).map(
              ([k, x]) => {
                const c = obj(x, 'revenue.currency');
                return [
                  k,
                  {
                    receivedMinor: money(c.receivedMinor),
                    refundedMinor: money(c.refundedMinor),
                    netMinor: money(c.netMinor),
                  },
                ];
              }
            )
          ),
          externalPayingProspects: int(r.externalPayingProspects),
          contractsSigned: int(r.contractsSigned),
          excludedNonExternal: int(r.excludedNonExternal),
          commercialValidation: choice(
            r.commercialValidation,
            ['confirmed', 'not_confirmed'] as const,
            'commercialValidation'
          ),
        }
      : null,
    placements: arr(o.placements ?? [], 'placements').map((x) => {
      const p = obj(x, 'placement');
      return {
        id: str(p.id),
        placementCode: str(p.placementCode),
        publishedAt: strN(p.publishedAt),
        windowState: choice(p.windowState, WINDOW_STATES, 'windowState'),
        late: bool(p.late),
        deliveredMinor: money(p.deliveredMinor),
        deliveryUnconfirmed:
          p.deliveryUnconfirmed === undefined || p.deliveryUnconfirmed === null
            ? null
            : bool(p.deliveryUnconfirmed),
        technicalQualified: int(p.technicalQualified),
        directCpl: computable(p.directCpl, money, 'placement.directCpl'),
      };
    }),
    experimentConclusion: choiceN(
      o.experimentConclusion,
      ['any', 'inconclusive_only'] as const,
      'experimentConclusion'
    ),
    diagnostics: dg
      ? Object.fromEntries(
          Object.entries(dg).map(([k, x]) => [k, int(x, `diagnostics.${k}`)])
        )
      : null,
  };
}

export function decodeCosts(v: unknown): ReportCosts {
  const o = obj(v ?? {}, 'costs');
  const ec = opt(o, 'economic');
  const cash = opt(o, 'cash');
  const parts = opt(o, 'parts');
  const flat: Record<string, string> = {};
  let mwr: ReportCosts['minutesWithoutRate'] = null;
  let unpriced: number | null = null;
  if (parts) {
    for (const [k, x] of Object.entries(parts)) {
      if (k === 'minutesWithoutRate') {
        const m = obj(x, 'minutesWithoutRate');
        mwr = {
          operational: int(m.operational),
          investment: int(m.investment),
        };
      } else if (k === 'aiCallsUnpriced') {
        unpriced = int(x);
      } else {
        flat[k] = money(x);
      }
    }
  }
  const c = (x: unknown, w: string) =>
    x === undefined || x === null ? null : computable(x, money, w);
  return {
    currency: strN(o.currency),
    operational: c(ec?.operational, 'costs.operational'),
    investment: c(ec?.investment, 'costs.investment'),
    total: c(ec?.total, 'costs.total'),
    cashNetPaidMinor: minorN(cash?.netPaidMinor),
    advancesMinor: minorN(cash?.advancesMinor),
    minutesWithoutRate: mwr,
    aiCallsUnpriced: unpriced,
    parts: flat,
  };
}

function decodeCohort(v: unknown): ReportCohort {
  const o = obj(v ?? {}, 'cohort');
  return {
    t0: strN(o.t0),
    t42: strN(o.t42),
    start: strN(o.start),
    end: strN(o.end),
    closeAt: strN(o.closeAt),
    lateCohortEnd: strN(o.lateCohortEnd),
    sessionMode: strN(o.sessionMode),
  };
}

export function decodeReport(v: unknown): ReportView {
  const o = obj(v, 'report');
  return {
    ...decodeReportSummary(o),
    cohort: decodeCohort(o.cohort),
    attributionModel: choice(
      o.attributionModel,
      ['last_non_direct_30d'] as const,
      'attributionModel'
    ),
    sources: decodeSources(o.sources),
    metrics: decodeMetrics(o.metrics),
    costs: decodeCosts(o.costs),
    assumptions: strN(o.assumptions),
  };
}

export function decodePreview(v: unknown): EconomicsPreview {
  const o = obj(v, 'preview');
  if (o.preliminary !== true) return bad('preview.preliminary');
  return {
    preliminary: true,
    at: str(o.at),
    kind: choice(o.kind, REPORT_KINDS, 'preview.kind'),
    cohort: decodeCohort(o.cohort),
    sources: decodeSources(o.sources),
    metrics: decodeMetrics(o.metrics),
    costs: decodeCosts(o.costs),
  };
}

export function decodeBackup(v: unknown): BackupView {
  const o = obj(v, 'backup');
  const tc: Record<string, number> = {};
  for (const [k, x] of Object.entries(obj(o.tableCounts ?? {}, 'tableCounts')))
    tc[k] = int(x);
  return {
    id: str(o.id),
    kind: choice(o.kind, BACKUP_KINDS, 'backup.kind'),
    status: choice(o.status, BACKUP_STATUSES, 'backup.status'),
    sha256: str(o.sha256),
    sizeBytes: minor(o.sizeBytes),
    tableCounts: tc,
    keyVersion: str(o.keyVersion),
    rotationUntil: str(o.rotationUntil),
    createdAt: str(o.createdAt),
    createdBy: str(o.createdBy),
  };
}

export function decodeRestore(v: unknown): RestoreView {
  const o = obj(v, 'restore');
  return {
    id: str(o.id),
    backupId: str(o.backupId),
    mode: choice(o.mode, RESTORE_MODES, 'restore.mode'),
    targetProductId: strN(o.targetProductId),
    status: choice(o.status, RESTORE_STATUSES, 'restore.status'),
    report: o.report ?? null,
    startedBy: str(o.startedBy),
    createdAt: str(o.createdAt),
    updatedAt: str(o.updatedAt),
  };
}

/**
 * Тело новой версии эксперимента — зеркало `NewExperimentVersionBody`
 * (все поля регистрации необязательны, кроме `key`; плюс `lateCohortEnd`).
 */
/** День выгрузки метрик (`MetricImportDay` контракта). */
export type MetricImportDay = {
  date: string;
  page?: string | null;
  sessions?: number | null;
  engagedVisits?: number | null;
  impressions?: number | null;
  clicks?: number | null;
  indexed?: boolean | null;
  partial?: boolean;
  extra?: Record<string, number | null>;
};
export type ExperimentVersionIn = {
  hypothesis?: string;
  change?: string;
  metric?: string;
  expectedSignal?: string;
  stopConditions?: string;
  baselineVersionId?: string | null;
  newVersionId?: string | null;
  windowStart?: string;
  windowEnd?: string;
  limitMinor?: string | null;
  contentIds?: string[];
  lateCohortEnd?: string | null;
};

// ── Клиент ───────────────────────────────────────────────────────────────

export function createReportsApi(http: PublisherHttp) {
  const P = productPath;
  const { get, post, patch, put } = verbs(http);
  return {
    // Труд
    timeEntries: async (
      pid: string,
      f: { member?: string; before?: string } = {}
    ) => page(await get(`${P(pid)}/time-entries`, f), decodeTimeEntry),
    createTimeEntry: async (
      pid: string,
      opKey: string,
      body: {
        memberId?: string;
        role: TimeRole;
        task: string;
        minutes: number;
        workDate: string;
        category: TimeCategory;
        featureId?: string | null;
        contentId?: string | null;
      }
    ) =>
      decodeTimeEntry(await post(`${P(pid)}/time-entries`, { ...body }, opKey)),
    patchTimeEntry: async (
      pid: string,
      id: string,
      opKey: string,
      body: {
        expectedRevision: number;
        task?: string;
        minutes?: number;
        workDate?: string;
        category?: TimeCategory;
      }
    ) =>
      decodeTimeEntry(
        await patch(`${P(pid)}/time-entries/${seg(id)}`, { ...body }, opKey)
      ),

    // Импорт метрик и интеграции
    metricImports: async (pid: string, before?: string) =>
      page(
        await get(`${P(pid)}/metric-imports`, { before }),
        decodeMetricImport
      ),
    createMetricImport: async (
      pid: string,
      opKey: string,
      body: {
        source: (typeof METRIC_IMPORT_SOURCES)[number];
        periodStart: string;
        periodEnd: string;
        payload: {
          days: MetricImportDay[];
          definitions?: Record<string, string>;
        };
        fileRef?: string | null;
        note?: string | null;
      }
    ) =>
      decodeMetricImport(
        await post(`${P(pid)}/metric-imports`, { ...body }, opKey)
      ),
    integrations: async (pid: string) =>
      items(await get(`${P(pid)}/integrations`), decodeIntegration),
    putIntegration: async (
      pid: string,
      kind: IntegrationKind,
      opKey: string,
      body: {
        status: IntegrationStatus;
        expectedRevision?: number;
        note?: string | null;
        staleAfterHours?: number;
        lastSuccessAt?: string | null;
      }
    ) =>
      decodeIntegration(
        await put(`${P(pid)}/integrations/${seg(kind)}`, { ...body }, opKey)
      ),

    // Эксперименты F17
    experiments: async (pid: string) =>
      items(await get(`${P(pid)}/experiments`), decodeExperiment),
    registerExperiment: async (
      pid: string,
      opKey: string,
      body: {
        key: string;
        hypothesis: string;
        change: string;
        metric: string;
        expectedSignal: string;
        stopConditions: string;
        windowStart: string;
        windowEnd: string;
        baselineVersionId?: string | null;
        newVersionId?: string | null;
        limitMinor?: string | null;
        contentIds?: string[];
      }
    ) =>
      decodeExperiment(await post(`${P(pid)}/experiments`, { ...body }, opKey)),
    experimentVersion: async (
      pid: string,
      id: string,
      opKey: string,
      body: ExperimentVersionIn
    ) =>
      decodeExperiment(
        await post(
          `${P(pid)}/experiments/${seg(id)}/version`,
          { ...body },
          opKey
        )
      ),
    applyExperiment: async (pid: string, id: string, opKey: string) =>
      decodeExperiment(
        await post(`${P(pid)}/experiments/${seg(id)}/apply`, {}, opKey)
      ),
    concludeExperiment: async (
      pid: string,
      id: string,
      opKey: string,
      body: {
        conclusion: ExperimentConclusion;
        reason: string;
        decision: ExperimentDecision;
      }
    ) =>
      decodeExperiment(
        await post(
          `${P(pid)}/experiments/${seg(id)}/conclude`,
          { ...body },
          opKey
        )
      ),

    // Отчёты
    reports: async (
      pid: string,
      f: { kind?: ReportKind; before?: string } = {}
    ) => page(await get(`${P(pid)}/reports`, f), decodeReportSummary),
    report: async (pid: string, id: string) =>
      decodeReport(await get(`${P(pid)}/reports/${seg(id)}`)),
    createReport: async (
      pid: string,
      opKey: string,
      body: {
        kind: ReportKind;
        periodStart?: string;
        periodEnd?: string;
        snapshotAt?: string;
        experimentId?: string;
      }
    ) => decodeReport(await post(`${P(pid)}/reports`, { ...body }, opKey)),
    reportDecision: async (
      pid: string,
      id: string,
      opKey: string,
      decision: string
    ) =>
      decodeReport(
        await post(`${P(pid)}/reports/${seg(id)}/decision`, { decision }, opKey)
      ),
    recomputeReport: async (
      pid: string,
      id: string,
      opKey: string,
      reason: (typeof RECOMPUTE_REASONS_MANUAL)[number]
    ) =>
      decodeReport(
        await post(`${P(pid)}/reports/${seg(id)}/recompute`, { reason }, opKey)
      ),
    economicsPreview: async (pid: string) =>
      decodePreview(await get(`${P(pid)}/economics/preview`)),

    // Копии и восстановление
    backups: async (pid: string) =>
      items(await get(`${P(pid)}/backups`), decodeBackup),
    createBackup: async (pid: string, opKey: string) =>
      decodeBackup(await post(`${P(pid)}/backups`, { kind: 'manual' }, opKey)),
    restore: async (
      pid: string,
      backupId: string,
      opKey: string,
      body: { mode: 'dry_run' | 'apply_new_product'; targetSiteId?: string }
    ) =>
      decodeRestore(
        await post(
          `${P(pid)}/backups/${seg(backupId)}/restore`,
          { ...body },
          opKey
        )
      ),
    restoreStatus: async (pid: string, id: string) =>
      decodeRestore(await get(`${P(pid)}/restores/${seg(id)}`)),
  };
}

export type ReportsApi = ReturnType<typeof createReportsApi>;
