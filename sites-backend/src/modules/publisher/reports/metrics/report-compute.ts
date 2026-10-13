/**
 * AI Publisher — вычисление снимка отчёта (P-E, проектный документ §6.6,
 * §9.3–9.4, §15.1; ТЗ §14–16). ЧИСТАЯ функция: входы, которые собрал
 * `reports.service.ts` (сессии, заявки, решения, связи проспектов, оплаты,
 * расходы, труд, AI, импорт, интеграции), → блоки строки `pub_reports`
 * (`cohort`, `sources`, `metrics`, `costs`). Один и тот же вход — один и
 * тот же результат и `inputsHash` (воспроизводимость, AT-CORE-19).
 *
 * Определения периода:
 *  - `d42|d72|d90` — основная когорта [t0, t42) эксперимента `pilot`;
 *    заявки — от t0 до конца 30-дневных окон (t42 + 30 дней Kyiv)
 *    включительно и не позже `snapshotAt`;
 *  - `late_cohort` — сессии размещений, опубликованных после t42, в
 *    [первая поздняя публикация, `lateCohortEnd`); закрытие — +30 дней;
 *  - `weekly|ad_hoc` — [periodStart, periodEnd) для сессий, заявок и затрат.
 * Заявки поздних размещений в основной результат не входят (ТЗ §15).
 */
import type { Computable, Minor } from '../../contracts/common';
import { canonicalJson, sha256Hex } from '../../core/content-hash';
import {
  addKyivCalendarDays,
  inHalfOpen,
  kyivDateOf,
} from '../../core/kyiv-time';
import { jsonSafe } from '../../core/money';
import {
  PENDING_STATUSES,
  PROPOSAL_STATUSES,
  QUALIFIED_STATUSES,
  cohortCloseAt,
  cohortSessions,
  cohortSessionsFromAggregates,
  cohortWindowClosed,
  coverage,
  isExternalProspect,
  leadInSessionWindow,
  placementWindowState,
  prospectAt,
  statusAt,
  uniqueQualifiedProspects,
  type DecisionIn,
  type KyivDayAggregate,
  type LeadIn,
  type ProspectIn,
  type ProspectLinkIn,
  type SessionIn,
} from './cohorts';
import {
  addCosts,
  allowedOperationalCpl,
  autoRefundsOf,
  compareWithAllowed,
  costPer,
  directCpl,
  experimentConclusionAllowed,
  fullOperationalCplTechnical,
  investmentCac,
  investmentCpl,
  knownCost,
  operationalCac,
  operationalCost,
  paymentActiveAt,
  preliminaryIf,
  productCpl,
  qualifiedPer100Sessions,
  revenueSummary,
  searchSignalD90,
  signalD42,
  type AiCallCostIn,
  type Cost,
  type ExpenseCostIn,
  type PaymentIn,
  type RatesIn,
  type TimeEntryCostIn,
} from './economics';

export type ReportKind =
  'weekly' | 'd42' | 'd72' | 'd90' | 'late_cohort' | 'ad_hoc';
export type SessionMode = 'session_ref' | 'imported_aggregate';

/** Пороги, замороженные в версии эксперимента при регистрации (AT-CORE-23). */
export interface FrozenThresholds {
  d42: {
    sessions: number;
    qualified: number;
    proposals: number;
    minSampleForConclusion: number;
  };
  d90: { indexedPages: number; pagesTotal: number; pagesWithClicks28d: number };
  allowedCpl: {
    contributionMinor: number | null;
    pPayBp: number | null;
    shareBp: number | null;
  };
  lateCohort: { closeAfterDays: number; explicitEndRequired: boolean };
  /** Версия и статус каждого параметра на момент регистрации. */
  versions: Record<string, { version: number; status: string }>;
}

export interface ExperimentIn {
  id: string;
  key: string;
  version: number;
  kind: 'pilot' | 'change';
  t0: Date | null;
  t42: Date | null;
  t72: Date | null;
  t90: Date | null;
  lateCohortEnd: Date | null;
  windowStart: Date;
  windowEnd: Date;
  registeredAt: Date;
  thresholds: FrozenThresholds;
}

export interface PlacementIn {
  id: string;
  placementCode: string;
  publishedAt: Date | null;
}

export interface ExpenseIn {
  id: string;
  category: 'placements' | 'tools' | 'other';
  placementId: string | null;
  aiMonth: boolean;
}

export interface ExpenseEntryIn {
  expenseId: string;
  kind: 'commit' | 'pay' | 'refund' | 'cancel' | 'deliver' | 'adjust';
  status: 'confirmed' | 'pending' | 'unknown' | 'void';
  amountMinor: Minor;
  occurredAt: Date;
  confirmedAt: Date | null;
}

export interface TimeEntryIn extends TimeEntryCostIn {
  /** Дата работы по Kyiv `YYYY-MM-DD`. */
  workDate: string;
}

export interface AiCallIn extends AiCallCostIn {
  requestedAt: Date;
}

export interface SearchDayIn {
  date: string;
  page: string;
  clicks: number | null;
  indexed: boolean | null;
}

export interface IntegrationIn {
  kind: string;
  status: 'connected' | 'degraded' | 'disconnected';
  manual: boolean;
  lastSuccessAt: Date | null;
  staleAfterHours: number;
}

export interface ReportInputs {
  kind: ReportKind;
  periodStart: Date;
  periodEnd: Date;
  snapshotAt: Date;
  currency: string;
  experiment: ExperimentIn | null;
  sessionMode: SessionMode;
  sessions: SessionIn[];
  aggregates: KyivDayAggregate[];
  leads: LeadIn[];
  decisions: DecisionIn[];
  links: ProspectLinkIn[];
  prospects: ProspectIn[];
  payments: PaymentIn[];
  placements: PlacementIn[];
  expenses: ExpenseIn[];
  expenseEntries: ExpenseEntryIn[];
  timeEntries: TimeEntryIn[];
  aiCalls: AiCallIn[];
  rates: RatesIn;
  aiFxRate: string | null;
  /** Текущий параметр — если в эксперименте не заморожен. */
  allowedCplInputs: {
    contributionMinor: number | null;
    pPayBp: number | null;
    shareBp: number | null;
    approved: boolean;
  };
  cacWindow: { until: 't72' | 't90' | 'days'; days: number | null };
  /**
   * Пакет разработки P0 (`dev_investment`, Р-PUB-Z2-24): сумма — только
   * утверждённая; допущение или неизвестная сумма — инвестиционные
   * показатели «не менее» (неизвестное ≠ 0). Нет поля — вход не задан
   * (чистые тесты формул); `ReportsService` передаёт его всегда.
   */
  devInvestment?: { approved: boolean; amountMinor: number | null };
  searchDays: SearchDayIn[];
  integrations: IntegrationIn[];
  /**
   * Страницы пилота (пути URL живых публикаций материалов эксперимента):
   * поисковый сигнал D90 — только по ним (аудит P-E S3-10). null — без
   * фильтра (материалы эксперимента не заданы).
   */
  pilotPages?: string[] | null;
  /**
   * Диагностический снимок одного размещения (+7/+14 дней): только его
   * сессии и заявки. Окно обращения он не закрывает.
   */
  focusPlacementId?: string | null;
}

const HOUR_MS = 3_600_000;
/** Потолок `staleAfterHours` интеграции (аудит P-E S3-5): неделя. */
export const MAX_STALE_AFTER_HOURS = 168;
const staleMs = (g: IntegrationIn) =>
  Math.min(g.staleAfterHours, MAX_STALE_AFTER_HOURS) * HOUR_MS;

export interface ReportComputation {
  cohort: Record<string, unknown>;
  sources: Record<string, unknown>;
  metrics: Record<string, unknown>;
  costs: Record<string, unknown>;
  /** Заявки и проспекты когорты — для `report-staleness`. */
  membership: { leadIds: string[]; prospectIds: string[] };
  inputsHash: string;
}

/** sha256 канонического JSON входов (bigint → строка, Date → ISO). */
export function reportInputsHash(inputs: ReportInputs): string {
  return sha256Hex(canonicalJson(jsonSafe(inputs)));
}

interface Range {
  start: Date;
  end: Date;
}

function rangeOf(i: ReportInputs): {
  cohort: Range;
  /** Заявки: [start, endInclusive]. */
  leads: { start: Date; endInclusive: Date };
  costs: Range | null;
  latePlacementIds: Set<string>;
  main: boolean;
} {
  const e = i.experiment;
  const late = new Set<string>();
  if (e?.t42) {
    for (const p of i.placements) {
      if (p.publishedAt && p.publishedAt.getTime() >= e.t42.getTime())
        late.add(p.id);
    }
  }
  if (i.kind === 'd42' || i.kind === 'd72' || i.kind === 'd90') {
    if (!e?.t0 || !e.t42)
      throw new RangeError('report: у эксперимента нет t0/t42');
    return {
      cohort: { start: e.t0, end: e.t42 },
      leads: { start: e.t0, endInclusive: addKyivCalendarDays(e.t42, 30) },
      costs: null,
      latePlacementIds: late,
      main: true,
    };
  }
  if (i.kind === 'late_cohort') {
    if (!e?.lateCohortEnd)
      throw new RangeError('report: нет явного конца поздней когорты');
    const starts = i.placements
      .filter((p) => late.has(p.id) && p.publishedAt)
      .map((p) => (p.publishedAt as Date).getTime());
    const start = new Date(
      starts.length ? Math.min(...starts) : i.periodStart.getTime(),
    );
    return {
      cohort: { start, end: e.lateCohortEnd },
      leads: { start, endInclusive: addKyivCalendarDays(e.lateCohortEnd, 30) },
      costs: null,
      latePlacementIds: late,
      main: false,
    };
  }
  return {
    cohort: { start: i.periodStart, end: i.periodEnd },
    leads: {
      start: i.periodStart,
      endInclusive: new Date(i.periodEnd.getTime() - 1),
    },
    costs: { start: i.periodStart, end: i.periodEnd },
    latePlacementIds: late,
    main: false,
  };
}

function computableJson<T>(c: Computable<T>): unknown {
  return jsonSafe(c);
}

/** Расходы на снимок: только подтверждённые записи с моментом ≤ snapshotAt. */
function expensesAsOf(
  i: ReportInputs,
  window: Range | null,
): Array<ExpenseCostIn & { committedMinor: Minor; cancelledMinor: Minor }> {
  const t = i.snapshotAt.getTime();
  const sums = new Map<
    string,
    {
      delivered: Minor;
      adjust: Minor;
      paid: Minor;
      refunded: Minor;
      committed: Minor;
      cancelled: Minor;
    }
  >();
  for (const en of i.expenseEntries) {
    if (en.status !== 'confirmed') continue;
    const at = (en.confirmedAt ?? en.occurredAt).getTime();
    if (at > t || en.occurredAt.getTime() > t) continue;
    if (window && !inHalfOpen(en.occurredAt, window.start, window.end))
      continue;
    const s = sums.get(en.expenseId) ?? {
      delivered: 0n,
      adjust: 0n,
      paid: 0n,
      refunded: 0n,
      committed: 0n,
      cancelled: 0n,
    };
    if (en.kind === 'deliver') s.delivered += en.amountMinor;
    else if (en.kind === 'commit') s.committed += en.amountMinor;
    else if (en.kind === 'cancel') s.cancelled += en.amountMinor;
    else if (en.kind === 'adjust') s.adjust += en.amountMinor;
    else if (en.kind === 'pay') s.paid += en.amountMinor;
    else if (en.kind === 'refund') s.refunded += en.amountMinor;
    sums.set(en.expenseId, s);
  }
  return i.expenses.map((e) => {
    const s = sums.get(e.id) ?? {
      delivered: 0n,
      adjust: 0n,
      paid: 0n,
      refunded: 0n,
      committed: 0n,
      cancelled: 0n,
    };
    return {
      id: e.id,
      category: e.category,
      placementId: e.placementId,
      aiMonth: e.aiMonth,
      deliveredMinor: s.delivered,
      adjustMinor: s.adjust,
      paidMinor: s.paid,
      refundedMinor: s.refunded,
      committedMinor: s.committed,
      cancelledMinor: s.cancelled,
    };
  });
}

/**
 * Полнота сессий режима `session_ref` (аудит P-E S2-3): сборщик событий
 * подключён и синхронизирован не раньше чем за `staleAfterHours` до конца
 * периода (или снимка, если он раньше). Иначе число сессий — нижняя
 * оценка: сигнал D42 по сессиям «неопределённо», а не «не выполнено».
 */
function sessionSourceComplete(i: ReportInputs, until: Date): boolean {
  const g = i.integrations.find((x) => x.kind === 'events_collector');
  if (!g || g.status !== 'connected' || !g.lastSuccessAt) return false;
  return until.getTime() - g.lastSuccessAt.getTime() <= staleMs(g);
}

function sourcesOf(
  i: ReportInputs,
  sessionsInfo: { partialDays: string[]; missingDays: string[] } | null,
): {
  list: unknown[];
  completeness: {
    state: 'complete' | 'partial' | 'unknown';
    missing: string[];
  };
} {
  const missing: string[] = [];
  const list = i.integrations.map((g) => {
    const stale =
      g.status === 'connected' &&
      (!g.lastSuccessAt ||
        i.snapshotAt.getTime() - g.lastSuccessAt.getTime() > staleMs(g));
    if (g.status !== 'connected' || stale)
      missing.push(`integration:${g.kind}`);
    return {
      kind: g.kind,
      status: g.status,
      manual: g.manual,
      lastSyncedAt: g.lastSuccessAt ? g.lastSuccessAt.toISOString() : null,
      stale,
    };
  });
  for (const k of ['events_collector', 'web_analytics']) {
    if (!i.integrations.some((g) => g.kind === k))
      missing.push(`integration:${k}`);
  }
  if (sessionsInfo) {
    for (const d of sessionsInfo.missingDays)
      missing.push(`web_analytics_day:${d}`);
  }
  const state =
    sessionsInfo && sessionsInfo.missingDays.length > 0
      ? 'unknown'
      : missing.length > 0 || (sessionsInfo?.partialDays.length ?? 0) > 0
        ? 'partial'
        : 'complete';
  return {
    list,
    completeness: { state, missing: [...new Set(missing)].sort() },
  };
}

/** Снимок отчёта из собранных входов (чистая функция). */
export function computeReport(i: ReportInputs): ReportComputation {
  const r = rangeOf(i);
  const snap = i.snapshotAt;
  const e = i.experiment;

  // ── Сессии ──────────────────────────────────────────────────────────────
  let cohortS = cohortSessions(i.sessions, r.cohort.start, r.cohort.end);
  if (i.kind === 'late_cohort') {
    cohortS = cohortS.filter(
      (s) => s.placementId && r.latePlacementIds.has(s.placementId),
    );
  }
  const focus = i.focusPlacementId ?? null;
  if (focus) cohortS = cohortS.filter((s) => s.placementId === focus);
  // Сессии после снимка в снимок не попадают (воспроизводимость).
  cohortS = cohortS.filter((s) => s.startedAt.getTime() <= snap.getTime());
  const testSessions = i.sessions.filter(
    (s) => s.testFlag && inHalfOpen(s.startedAt, r.cohort.start, r.cohort.end),
  ).length;
  let sessionsCount: number | null;
  let aggInfo: { partialDays: string[]; missingDays: string[] } | null = null;
  // Сессии известны полностью (для сигнала); иначе — нижняя оценка.
  let sessionsComplete = true;
  if (i.sessionMode === 'session_ref') {
    sessionsCount = cohortS.length;
    sessionsComplete = sessionSourceComplete(
      i,
      new Date(Math.min(r.cohort.end.getTime(), snap.getTime())),
    );
  } else if (i.kind === 'late_cohort' || focus) {
    // Суточные агрегаты не делятся по размещениям — сессии неизвестны, а не 0.
    sessionsCount = null;
  } else {
    const end = new Date(
      Math.min(
        r.cohort.end.getTime(),
        Math.max(snap.getTime(), r.cohort.start.getTime() + 1),
      ),
    );
    const a = cohortSessionsFromAggregates(i.aggregates, r.cohort.start, end);
    sessionsCount = a.sessions;
    aggInfo = { partialDays: a.partialDays, missingDays: a.missingDays };
  }
  const bySessionRef = new Map(cohortS.map((s) => [s.sessionRef, s]));
  // Все сессии продукта: заявка ИЗВЕСТНОЙ сессии вне когорты (или вне окна
  // своей сессии) — не «неизвестная», а вне когорты (аудит P-E S1-2).
  const allByRef = new Map(i.sessions.map((s) => [s.sessionRef, s]));

  // ── Заявки когорты/периода ─────────────────────────────────────────────
  const inPeriod = (l: LeadIn) =>
    l.receivedAt.getTime() >= r.leads.start.getTime() &&
    l.receivedAt.getTime() <= r.leads.endInclusive.getTime() &&
    l.receivedAt.getTime() <= snap.getTime();
  const linkedLeadIds = new Set<string>();
  const leadSet = new Set<string>();
  let testLeads = 0;
  const outside = { nextPeriod: 0, afterSessionWindow: 0 };
  for (const l of i.leads) {
    if (!inPeriod(l)) continue;
    if (l.testFlag) {
      testLeads++;
      continue;
    }
    const s = l.sessionRef ? bySessionRef.get(l.sessionRef) : undefined;
    const linked = !!s && leadInSessionWindow(l, s);
    if (linked) linkedLeadIds.add(l.id);
    if (r.main && i.sessionMode === 'session_ref' && !linked && l.sessionRef) {
      const known = allByRef.get(l.sessionRef);
      if (known) {
        // Сессия есть: в когорте, но заявка после её 30-дневного окна, —
        // или сессия вне [t0, t42) (ровно t42 — уже следующий период).
        if (s) outside.afterSessionWindow++;
        else outside.nextPeriod++;
        continue;
      }
    }
    if (
      r.main &&
      !linked &&
      l.placementId &&
      r.latePlacementIds.has(l.placementId)
    )
      continue;
    if (
      i.kind === 'late_cohort' &&
      !linked &&
      !(l.placementId && r.latePlacementIds.has(l.placementId))
    ) {
      continue;
    }
    if (focus && !linked && l.placementId !== focus) continue;
    leadSet.add(l.id);
  }
  const leadsById = new Map(i.leads.map((l) => [l.id, l]));
  const qualifiedAll = uniqueQualifiedProspects(
    i.leads,
    i.decisions,
    i.links,
    i.prospects,
    snap,
    {
      externalOnly: true,
      leadIds: leadSet,
    },
  );
  const proposals = uniqueQualifiedProspects(
    i.leads,
    i.decisions,
    i.links,
    i.prospects,
    snap,
    {
      externalOnly: true,
      leadIds: leadSet,
      statuses: PROPOSAL_STATUSES,
    },
  );
  // «На 100 сессий» в режиме агрегатов: заявки того же периода, что сессии.
  const samePeriodLeads = new Set(
    [...leadSet].filter((id) =>
      inHalfOpen(
        (leadsById.get(id) as LeadIn).receivedAt,
        r.cohort.start,
        r.cohort.end,
      ),
    ),
  );
  const samePeriodQualified = uniqueQualifiedProspects(
    i.leads,
    i.decisions,
    i.links,
    i.prospects,
    snap,
    { externalOnly: true, leadIds: samePeriodLeads },
  );
  // Основная техническая связь проспекта — первая квалифицированная заявка.
  const firstQualified = new Map<string, LeadIn>();
  for (const id of leadSet) {
    const l = leadsById.get(id) as LeadIn;
    if (!QUALIFIED_STATUSES.includes(statusAt(i.decisions, id, snap))) continue;
    const pid = prospectAt(i.links, id, snap);
    if (!pid || !qualifiedAll.has(pid)) continue;
    const prev = firstQualified.get(pid);
    if (
      !prev ||
      l.receivedAt.getTime() < prev.receivedAt.getTime() ||
      (l.receivedAt.getTime() === prev.receivedAt.getTime() && l.id < prev.id)
    ) {
      firstQualified.set(pid, l);
    }
  }
  const linkedProspects = new Set<string>();
  const placementOfProspect = new Map<string, string>();
  for (const [pid, l] of firstQualified) {
    if (!linkedLeadIds.has(l.id)) continue;
    linkedProspects.add(pid);
    const s = l.sessionRef ? bySessionRef.get(l.sessionRef) : undefined;
    if (s?.placementId) placementOfProspect.set(pid, s.placementId);
  }
  const cov = coverage(qualifiedAll, linkedProspects);
  let pending = 0;
  for (const id of leadSet) {
    if (PENDING_STATUSES.includes(statusAt(i.decisions, id, snap))) pending++;
  }
  const testQualified = i.leads.filter(
    (l) =>
      l.testFlag &&
      inPeriod(l) &&
      QUALIFIED_STATUSES.includes(statusAt(i.decisions, l.id, snap)),
  ).length;
  const prospectsById = new Map(i.prospects.map((p) => [p.id, p]));
  const teamQualified = new Set<string>();
  for (const id of leadSet) {
    if (!QUALIFIED_STATUSES.includes(statusAt(i.decisions, id, snap))) continue;
    const pid = prospectAt(i.links, id, snap);
    if (pid && !isExternalProspect(prospectsById.get(pid)))
      teamQualified.add(pid);
  }
  const mainT72 = r.main ? (e?.t72 ?? null) : null;
  const windowClosed = cohortWindowClosed(r.cohort.end, snap, mainT72);
  // «Предварительно» у CPL/CAC (аудит P-E S3-6) — у снимков когорт и
  // недель; `ad_hoc` — текущий/диагностический срез (паспорт трафика P-D
  // считает им же) — без пометки, как раньше.
  const windowOpen = !windowClosed && i.kind !== 'ad_hoc';

  // ── Затраты ─────────────────────────────────────────────────────────────
  const costWindow = r.costs;
  const costTo = costWindow
    ? Math.min(snap.getTime(), costWindow.end.getTime() - 1)
    : snap.getTime();
  const lastDay = kyivDateOf(new Date(costTo));
  const firstDay = costWindow ? kyivDateOf(costWindow.start) : null;
  const time = i.timeEntries.filter(
    (t) =>
      t.workDate <= lastDay && (firstDay === null || t.workDate >= firstDay),
  );
  const expenses = expensesAsOf(i, costWindow);
  // Оказание опубликованного размещения — по всем записям до снимка (не
  // только окна затрат): обязательство/аванс до периода тоже в счёт.
  const allToSnap = expensesAsOf(i, null);
  const ai = i.aiCalls.filter(
    (c) =>
      c.requestedAt.getTime() <= snap.getTime() &&
      (!costWindow ||
        inHalfOpen(c.requestedAt, costWindow.start, costWindow.end)),
  );

  // Прямой CPL по размещениям.
  const lastSession = new Map<string, Date>();
  for (const s of i.sessions) {
    if (s.testFlag || !s.placementId) continue;
    if (s.startedAt.getTime() > snap.getTime()) continue;
    const prev = lastSession.get(s.placementId);
    if (!prev || s.startedAt.getTime() > prev.getTime())
      lastSession.set(s.placementId, s.startedAt);
  }
  const placementRows = i.placements.map((p) => {
    const mine = expenses.filter((x) => x.placementId === p.id);
    const delivered = mine.reduce(
      (a, x) => a + x.deliveredMinor + x.adjustMinor,
      0n,
    );
    // Опубликовано, а оказание не подтверждено: обязательство или оплата
    // больше оказанного (аудит P-E S2-4) — числитель неизвестен.
    const published =
      !!p.publishedAt && p.publishedAt.getTime() <= snap.getTime();
    const gap = allToSnap
      .filter((x) => x.placementId === p.id)
      .some((x) => {
        const owed = x.committedMinor - x.cancelledMinor;
        const paid = x.paidMinor - x.refundedMinor;
        return (owed > paid ? owed : paid) > x.deliveredMinor;
      });
    const unconfirmed = published && gap;
    const linkedHere = [...placementOfProspect.values()].filter(
      (v) => v === p.id,
    ).length;
    return {
      id: p.id,
      placementCode: p.placementCode,
      publishedAt: p.publishedAt ? p.publishedAt.toISOString() : null,
      windowState: placementWindowState(p, snap, lastSession.get(p.id) ?? null),
      late: r.latePlacementIds.has(p.id),
      deliveredMinor: delivered,
      deliveryUnconfirmed: unconfirmed,
      technicalQualified: linkedHere,
      directCpl: computableJson(
        preliminaryIf(
          directCpl(delivered, linkedHere, {
            deliveryUnconfirmed: unconfirmed ? 1 : 0,
          }),
          windowOpen,
        ),
      ),
    };
  });
  const relevantPlacements = placementRows.filter((p) =>
    i.kind === 'late_cohort' ? p.late : !(r.main && p.late),
  );
  const unconfirmedCount = relevantPlacements.filter(
    (p) => p.deliveryUnconfirmed,
  ).length;
  const cost = operationalCost(time, expenses, ai, i.rates, i.aiFxRate, {
    placementDeliveryUnconfirmed: unconfirmedCount,
    devInvestment:
      i.devInvestment === undefined
        ? undefined
        : i.devInvestment.approved && i.devInvestment.amountMinor !== null
          ? BigInt(i.devInvestment.amountMinor)
          : null,
  });
  const directAll = directCpl(
    relevantPlacements.reduce((a, p) => a + p.deliveredMinor, 0n),
    relevantPlacements.reduce((a, p) => a + p.technicalQualified, 0),
    { deliveryUnconfirmed: unconfirmedCount },
  );

  const opCplTech = fullOperationalCplTechnical(
    cost.operational,
    linkedProspects.size,
  );
  const prodCpl = productCpl(cost.operational, qualifiedAll.size);
  const invCpl = investmentCpl(
    cost.operational,
    cost.investment,
    linkedProspects.size,
  );
  const frozenAllowed = e?.thresholds?.allowedCpl;
  // С экспериментом — только замороженный порог; без него (ad_hoc) —
  // утверждённый параметр.
  const allowedSrc = e
    ? (frozenAllowed ?? null)
    : i.allowedCplInputs.approved
      ? i.allowedCplInputs
      : null;
  const allowed: Cost = allowedSrc
    ? allowedOperationalCpl({
        contributionMinor:
          allowedSrc.contributionMinor === null
            ? null
            : BigInt(allowedSrc.contributionMinor),
        pPayBp: allowedSrc.pPayBp,
        shareBp: allowedSrc.shareBp,
      })
    : {
        kind: 'not_computable',
        reason: 'unknown_input',
        inputs: { allowedCplApproved: 0 },
      };

  // ── CAC и выручка ───────────────────────────────────────────────────────
  const cacEnd =
    e?.t0 && i.cacWindow.until === 't72' && e.t72
      ? e.t72
      : e?.t0 && i.cacWindow.until === 't90' && e.t90
        ? e.t90
        : e?.t0 && i.cacWindow.until === 'days' && i.cacWindow.days
          ? addKyivCalendarDays(e.t0, i.cacWindow.days)
          : snap;
  const newPaying = new Set<string>();
  const unknownNew = new Set<string>();
  const autoRefunds = autoRefundsOf(i.payments);
  for (const p of i.payments) {
    if (p.payerKind !== 'external' || p.recordType !== 'payment_received')
      continue;
    // Возвращённая к снимку оплата — не оплата CAC (аудит P-E S1-3);
    // проспект, НА СНИМКЕ не внешний, — тоже (S3-7).
    if (!paymentActiveAt(p, snap, autoRefunds)) continue;
    if (!isExternalProspect(prospectsById.get(p.prospectId))) continue;
    if (p.occurredAt.getTime() < r.cohort.start.getTime()) continue;
    if (p.occurredAt.getTime() > cacEnd.getTime()) continue;
    if (!linkedProspects.has(p.prospectId)) continue;
    if (p.isNewCustomer === 'yes') newPaying.add(p.prospectId);
    else if (p.isNewCustomer === 'unknown') unknownNew.add(p.prospectId);
  }
  for (const pid of newPaying) unknownNew.delete(pid);
  const opCac = operationalCac(
    cost.operational,
    newPaying.size,
    unknownNew.size,
  );
  const invCac = investmentCac(
    cost.operational,
    cost.investment,
    newPaying.size,
    unknownNew.size,
  );
  const revenue = revenueSummary(i.payments, snap, (pid) =>
    isExternalProspect(prospectsById.get(pid)),
  );

  // ── Сигналы ─────────────────────────────────────────────────────────────
  // Пороги — только замороженные в эксперименте и только полные: неполный
  // набор не дополняется текущими параметрами («не подтягивается»), сигнал
  // тогда не рассчитывается (null), а заключение — только «невизначено».
  const th = e?.thresholds;
  const num = (v: unknown): v is number =>
    typeof v === 'number' && Number.isFinite(v);
  const th42 =
    th?.d42 &&
    num(th.d42.sessions) &&
    num(th.d42.qualified) &&
    num(th.d42.proposals)
      ? th.d42
      : null;
  const th90 =
    th?.d90 && num(th.d90.indexedPages) && num(th.d90.pagesWithClicks28d)
      ? th.d90
      : null;
  const minSample = num(th?.d42?.minSampleForConclusion)
    ? th.d42.minSampleForConclusion
    : null;
  const d42 = th42
    ? signalD42(
        {
          sessions: sessionsComplete ? sessionsCount : null,
          qualifiedUnique: qualifiedAll.size,
          linked: cov.linked,
          unknown: cov.unknown,
          proposalsToDistinct: proposals.size,
        },
        th42,
      )
    : null;
  const search = searchInputs(i.searchDays, snap, i.pilotPages ?? null);
  const d90 = th90
    ? searchSignalD90(search, {
        indexedPages: th90.indexedPages,
        pagesWithClicks28d: th90.pagesWithClicks28d,
      })
    : null;
  const conclusion =
    minSample !== null
      ? experimentConclusionAllowed({
          windowClosed,
          qualifiedUnique: qualifiedAll.size,
          minSample,
        })
      : 'inconclusive_only';

  const src = sourcesOf(i, aggInfo);
  let per100 = qualifiedPer100Sessions(
    i.sessionMode === 'session_ref' ? cov.linked : samePeriodQualified.size,
    sessionsCount,
    windowClosed,
  );
  if (!sessionsComplete && per100.kind === 'value') {
    per100 = {
      ...per100,
      preliminary: true,
      unknownParts: ['sessions:collector_incomplete'],
    };
  }
  const membershipProspects = new Set<string>();
  for (const id of leadSet) {
    const pid = prospectAt(i.links, id, snap);
    if (pid) membershipProspects.add(pid);
  }

  const metrics = {
    sessions: {
      mode: i.sessionMode,
      value: sessionsCount,
      complete: sessionsComplete && sessionsCount !== null,
      partialDays: aggInfo?.partialDays ?? [],
      missingDays: aggInfo?.missingDays ?? [],
    },
    leads: {
      inPeriod: leadSet.size,
      linked: linkedLeadIds.size,
      pending,
      qualifiedUnique: qualifiedAll.size,
      linkedQualified: cov.linked,
      unknownQualified: cov.unknown,
      coverage: computableJson(cov.ratio),
      proposalsToDistinct: proposals.size,
      outsideCohort: outside,
    },
    qualifiedPer100Sessions: {
      // Одна база: связанные с сессиями когорты / сессии когорты; в режиме
      // агрегатов — заявки и сессии ОДНОГО периода [начало, конец) (аудит
      // P-E S1-2: не заявки до t72 на сессии до t42).
      basis: i.sessionMode === 'session_ref' ? 'linked_cohort' : 'period_ratio',
      value: computableJson(per100),
    },
    windowClosed,
    signalD42: d42,
    searchSignalD90: d90 ? { ...d90, inputs: search } : null,
    economics: {
      directCpl: computableJson(preliminaryIf(directAll, windowOpen)),
      fullOperationalCplTechnical: computableJson(
        preliminaryIf(opCplTech, windowOpen),
      ),
      productCpl: computableJson(preliminaryIf(prodCpl, windowOpen)),
      investmentCpl: computableJson(preliminaryIf(invCpl, windowOpen)),
      allowedOperationalCpl: computableJson(allowed),
      economicSignal: computableJson(compareWithAllowed(opCplTech, allowed)),
      operationalCac: computableJson(preliminaryIf(opCac, windowOpen)),
      investmentCac: computableJson(preliminaryIf(invCac, windowOpen)),
      newPayingLinked: newPaying.size,
      newCustomerUnknown: unknownNew.size,
      cacWindowEnd: cacEnd.toISOString(),
    },
    revenue: jsonSafe(revenue),
    placements: jsonSafe(placementRows),
    experimentConclusion: conclusion,
    diagnostics: {
      testSessions,
      testLeads,
      testQualified,
      teamOrPartnerQualified: teamQualified.size,
      excludedPayments: revenue.excludedNonExternal,
    },
    membership: {
      leadIds: [...leadSet].sort(),
      prospectIds: [...membershipProspects].sort(),
    },
  };
  const costs = jsonSafe({
    currency: i.currency,
    economic: {
      operational: cost.operational,
      investment: cost.investment,
      total: addCosts(cost.operational, cost.investment),
    },
    cash: { netPaidMinor: cost.cash, advancesMinor: cost.parts.advancesMinor },
    parts: cost.parts,
    window: costWindow
      ? {
          start: costWindow.start.toISOString(),
          end: costWindow.end.toISOString(),
        }
      : { start: null, end: snap.toISOString() },
  }) as Record<string, unknown>;
  const cohort = {
    t0: e?.t0?.toISOString() ?? null,
    t42: e?.t42?.toISOString() ?? null,
    start: r.cohort.start.toISOString(),
    end: r.cohort.end.toISOString(),
    closeAt: cohortCloseAt(r.cohort.end, mainT72).toISOString(),
    lateCohortEnd: e?.lateCohortEnd?.toISOString() ?? null,
    sessionMode: i.sessionMode,
    experimentId: e?.id ?? null,
    experimentVersion: e?.version ?? null,
    ...(focus ? { focusPlacementId: focus } : {}),
  };
  return {
    cohort,
    sources: { integrations: src.list, completeness: src.completeness },
    metrics,
    costs,
    membership: metrics.membership,
    inputsHash: reportInputsHash(i),
  };
}

/**
 * Вход поискового сигнала D90 из суточных данных Search Console: страницы
 * с подтверждённой индексацией на последнюю доступную дату и страницы с
 * кликами за последние 28 доступных дней до снимка. Нет данных — null.
 */
export function searchInputs(
  days: readonly SearchDayIn[],
  snapshotAt: Date,
  pages: readonly string[] | null = null,
): { indexedPages: number | null; pagesWithClicks28d: number | null } {
  const until = kyivDateOf(snapshotAt);
  const only = pages ? new Set(pages.map(normPath)) : null;
  const usable = days.filter(
    (d) => d.date <= until && (!only || only.has(normPath(d.page))),
  );
  if (usable.length === 0)
    return { indexedPages: null, pagesWithClicks28d: null };
  const dates = [...new Set(usable.map((d) => d.date))].sort();
  const last = dates[dates.length - 1];
  const lastRows = usable.filter((d) => d.date === last);
  const indexedPages = lastRows.some((d) => d.indexed === null)
    ? null
    : new Set(lastRows.filter((d) => d.indexed).map((d) => d.page)).size;
  const window = new Set(dates.slice(-28));
  const inWindow = usable.filter((d) => window.has(d.date));
  const pagesWithClicks28d = inWindow.some((d) => d.clicks === null)
    ? null
    : new Set(inWindow.filter((d) => (d.clicks ?? 0) > 0).map((d) => d.page))
        .size;
  return { indexedPages, pagesWithClicks28d };
}

/** Путь страницы для сравнения: без завершающего `/` (кроме корня). */
export function normPath(p: string): string {
  return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
}

export { costPer, knownCost };
