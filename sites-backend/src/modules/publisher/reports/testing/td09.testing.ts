/**
 * AI Publisher — TD-09 (P-E, проектный документ §16.7; план внешнего
 * аудита): синтетический календарь пилота для когорт и отчётов — сессии до
 * и ровно в t0/t42, обращение на границе 30-дневного окна и через 1 мс,
 * окно через осенний переход, pending, отменённая квалификация, две задачи
 * одного проспекта, команда/партнёр, тестовые данные, поздняя квалификация,
 * поздняя публикация (отдельная когорта), оплаты внешние/внутренние/
 * тестовые, труд без ставки, AI без цены.
 *
 * ВСЕ моменты записаны литералами UTC и проверены вручную по правилам
 * Europe/Kyiv (EEST +03:00 до 25.10.2026 04:00, затем EET +02:00), а не
 * вычислены `kyiv-time`: тест сверяет функцию с независимым пересчётом.
 *
 *   t0  = 2026-10-20 10:00 EEST = 2026-10-20T07:00:00.000Z
 *   t42 = 2026-12-01 10:00 EET  = 2026-12-01T08:00:00.000Z (169 ч в 1-й неделе)
 *   t72 = 2026-12-31 10:00 EET  = 2026-12-31T08:00:00.000Z
 *   t90 = 2027-01-18 10:00 EET  = 2027-01-18T08:00:00.000Z
 */
import type { ReportInputs } from '../metrics/report-compute';

export const T0 = new Date('2026-10-20T07:00:00.000Z');
export const T42 = new Date('2026-12-01T08:00:00.000Z');
export const T72 = new Date('2026-12-31T08:00:00.000Z');
export const T90 = new Date('2027-01-18T08:00:00.000Z');
/** Неделя 1: [t0, t0 + 7 дней) — 2026-10-27 10:00 EET. */
export const WEEK1_END = new Date('2026-10-27T08:00:00.000Z');
export const LATE_END = new Date('2027-01-10T08:00:00.000Z');
/** LATE_END + 30 дней Kyiv (зима, без перехода) = 2027-02-09 10:00 EET. */
export const LATE_CLOSE = new Date('2027-02-09T08:00:00.000Z');

const d = (iso: string) => new Date(iso);

export const PL_A = 'pl_a';
export const PL_LATE = 'pl_late';

/** Сессии (sessionRef → момент; ожидаемая принадлежность к [t0, t42)). */
export const TD09_SESSIONS = {
  s_before: { at: '2026-10-20T06:59:59.999Z', inCohort: false },
  s_t0: { at: '2026-10-20T07:00:00.000Z', inCohort: true },
  /** 11:00 EEST за день до перехода: +30 дней = 2026-11-23 11:00 EET = 09:00Z. */
  s_dst: { at: '2026-10-24T08:00:00.000Z', inCohort: true },
  s_team: { at: '2026-11-05T10:00:00.000Z', inCohort: true },
  s_spam: { at: '2026-11-06T10:00:00.000Z', inCohort: true },
  s_rev: { at: '2026-11-07T10:00:00.000Z', inCohort: true },
  s_test: { at: '2026-11-02T10:00:00.000Z', inCohort: false },
  /** t42 − 1 мс: внутри; окно до 2026-12-31 09:59:59.999 EET = 07:59:59.999Z. */
  s_last: { at: '2026-12-01T07:59:59.999Z', inCohort: true },
  s_t42: { at: '2026-12-01T08:00:00.000Z', inCohort: false },
  s_late: { at: '2026-12-05T12:00:00.000Z', inCohort: false },
} as const;

export function td09Inputs(over: Partial<ReportInputs> = {}): ReportInputs {
  const S = TD09_SESSIONS;
  const sess = (
    ref: keyof typeof S,
    extra: Partial<{ testFlag: boolean; placementId: string | null }> = {},
  ) => ({
    sessionRef: ref,
    startedAt: d(S[ref].at),
    testFlag: extra.testFlag ?? false,
    placementId: extra.placementId ?? null,
    channelGroup: extra.placementId
      ? ('paid_placement' as const)
      : ('organic_search' as const),
  });
  const lead = (
    id: string,
    receivedAt: string,
    sessionRef: string | null,
    extra: Partial<{ testFlag: boolean; placementId: string | null }> = {},
  ) => ({
    id,
    receivedAt: d(receivedAt),
    testFlag: extra.testFlag ?? false,
    sessionRef,
    campaignId: 'camp',
    placementId: extra.placementId ?? null,
  });
  const dec = (
    id: string,
    leadId: string,
    toStatus: ReportInputs['decisions'][number]['toStatus'],
    at: string,
  ) => ({
    id,
    leadId,
    toStatus,
    decidedAt: d(at),
  });
  const link = (leadId: string, prospectId: string, at: string) => ({
    leadId,
    prospectId,
    validFrom: d(at),
  });
  const base: ReportInputs = {
    kind: 'd72',
    periodStart: T0,
    periodEnd: T72,
    snapshotAt: T72,
    currency: 'UAH',
    experiment: {
      id: 'exp_pilot',
      key: 'pilot',
      version: 1,
      kind: 'pilot',
      t0: T0,
      t42: T42,
      t72: T72,
      t90: T90,
      lateCohortEnd: null,
      windowStart: T0,
      windowEnd: T90,
      registeredAt: d('2026-10-01T07:00:00.000Z'),
      thresholds: {
        d42: {
          sessions: 100,
          qualified: 5,
          proposals: 2,
          minSampleForConclusion: 5,
        },
        d90: { indexedPages: 3, pagesTotal: 6, pagesWithClicks28d: 2 },
        allowedCpl: {
          contributionMinor: 10_001,
          pPayBp: 3_333,
          shareBp: 5_000,
        },
        lateCohort: { closeAfterDays: 30, explicitEndRequired: true },
        versions: {},
      },
    },
    sessionMode: 'session_ref',
    sessions: [
      sess('s_before'),
      sess('s_t0', { placementId: PL_A }),
      sess('s_dst', { placementId: PL_A }),
      sess('s_team'),
      sess('s_spam'),
      sess('s_rev'),
      sess('s_test', { testFlag: true }),
      sess('s_last'),
      sess('s_t42'),
      sess('s_late', { placementId: PL_LATE }),
    ],
    aggregates: [],
    leads: [
      // P1: две задачи — L4 (раньше, первая квалифицированная) и L1.
      lead('L1', '2026-12-31T07:59:59.999Z', 's_last'), // ровно конец окна — в окне
      lead('L2', '2026-12-31T08:00:00.000Z', 's_last'), // +1 мс после окна — не связан
      lead('L3', '2026-11-23T09:00:00.000Z', 's_dst'), // конец окна через переход (не 08:00Z)
      lead('L4', '2026-10-21T07:00:00.000Z', 's_t0'),
      lead('L5', '2026-11-02T11:00:00.000Z', 's_test', { testFlag: true }),
      lead('L6', '2026-11-05T11:00:00.000Z', 's_team'),
      lead('L7', '2026-11-06T11:00:00.000Z', 's_spam'),
      lead('L8', '2026-12-01T09:00:00.000Z', 's_t42'), // сессия ровно в t42 — вне когорты
      lead('L9', '2026-12-06T10:00:00.000Z', 's_late', {
        placementId: PL_LATE,
      }),
      lead('L10', '2026-11-10T10:00:00.000Z', null),
      lead('L11', '2026-11-07T11:00:00.000Z', 's_rev'),
    ],
    decisions: [
      dec('d1', 'L1', 'qualified', '2026-12-20T10:00:00.000Z'),
      dec('d2', 'L2', 'qualified', '2026-12-31T09:00:00.000Z'), // после t72 — поздняя
      dec('d3', 'L3', 'qualified', '2026-11-24T10:00:00.000Z'),
      dec('d3b', 'L3', 'proposal_sent', '2026-12-29T10:00:00.000Z'),
      dec('d4', 'L4', 'qualified', '2026-10-22T10:00:00.000Z'),
      dec('d4b', 'L4', 'proposal_sent', '2026-11-01T10:00:00.000Z'),
      dec('d5', 'L5', 'qualified', '2026-11-03T10:00:00.000Z'),
      dec('d6', 'L6', 'qualified', '2026-11-06T10:00:00.000Z'),
      dec('d7', 'L7', 'rejected', '2026-11-06T12:00:00.000Z'),
      dec('d8', 'L8', 'qualified', '2026-12-02T10:00:00.000Z'),
      dec('d9', 'L9', 'qualified', '2026-12-07T10:00:00.000Z'),
      dec('d11', 'L11', 'qualified', '2026-11-08T10:00:00.000Z'),
      dec('d11b', 'L11', 'contacted', '2026-11-09T10:00:00.000Z'), // отмена квалификации
    ],
    links: [
      link('L1', 'P1', '2026-12-31T07:59:59.999Z'),
      link('L2', 'P2', '2026-12-31T08:00:00.000Z'),
      link('L3', 'P3', '2026-11-23T09:00:00.000Z'),
      link('L4', 'P1', '2026-10-21T07:00:00.000Z'),
      link('L5', 'P5', '2026-11-02T11:00:00.000Z'),
      link('L6', 'P6', '2026-11-05T11:00:00.000Z'),
      link('L7', 'P7', '2026-11-06T11:00:00.000Z'),
      link('L8', 'P8', '2026-12-01T09:00:00.000Z'),
      link('L9', 'P9', '2026-12-06T10:00:00.000Z'),
      link('L10', 'P10', '2026-11-10T10:00:00.000Z'),
      link('L11', 'P11', '2026-11-07T11:00:00.000Z'),
    ],
    prospects: [
      { id: 'P1', isExternal: true, isTeamOrPartner: false },
      { id: 'P2', isExternal: true, isTeamOrPartner: false },
      { id: 'P3', isExternal: true, isTeamOrPartner: false },
      { id: 'P5', isExternal: false, isTeamOrPartner: true },
      { id: 'P6', isExternal: true, isTeamOrPartner: true },
      { id: 'P7', isExternal: true, isTeamOrPartner: false },
      { id: 'P8', isExternal: true, isTeamOrPartner: false },
      { id: 'P9', isExternal: true, isTeamOrPartner: false },
      { id: 'P10', isExternal: true, isTeamOrPartner: false },
      { id: 'P11', isExternal: true, isTeamOrPartner: false },
    ],
    payments: [
      {
        id: 'pay_ext',
        prospectId: 'P1',
        leadId: 'L4',
        recordType: 'payment_received',
        payerKind: 'external',
        amountMinor: 50_000n,
        currency: 'UAH',
        status: 'confirmed',
        occurredAt: d('2026-12-10T10:00:00.000Z'),
        confirmedAt: d('2026-12-10T12:00:00.000Z'),
        isNewCustomer: 'yes',
      },
      {
        id: 'pay_int',
        prospectId: 'P6',
        leadId: 'L6',
        recordType: 'payment_received',
        payerKind: 'internal',
        amountMinor: 10_000n,
        currency: 'UAH',
        status: 'confirmed',
        occurredAt: d('2026-11-20T10:00:00.000Z'),
        confirmedAt: d('2026-11-20T10:00:00.000Z'),
        isNewCustomer: 'no',
      },
      {
        id: 'pay_test',
        prospectId: 'P5',
        leadId: 'L5',
        recordType: 'payment_received',
        payerKind: 'test',
        amountMinor: 5_000n,
        currency: 'UAH',
        status: 'confirmed',
        occurredAt: d('2026-11-21T10:00:00.000Z'),
        confirmedAt: d('2026-11-21T10:00:00.000Z'),
        isNewCustomer: 'unknown',
      },
    ],
    placements: [
      {
        id: PL_A,
        placementCode: 'pl-a',
        publishedAt: d('2026-10-20T07:00:00.000Z'),
      },
      {
        id: PL_LATE,
        placementCode: 'pl-late',
        publishedAt: d('2026-12-05T10:00:00.000Z'),
      },
    ],
    expenses: [
      { id: 'ex_a', category: 'placements', placementId: PL_A, aiMonth: false },
      { id: 'ex_tools', category: 'tools', placementId: null, aiMonth: false },
      { id: 'ex_ai', category: 'tools', placementId: null, aiMonth: true },
    ],
    expenseEntries: [
      // Закупка А: оказано 1 500 грн (комиссия внутри цены), оплачено 1 200.
      {
        expenseId: 'ex_a',
        kind: 'commit',
        status: 'confirmed',
        amountMinor: 150_000n,
        occurredAt: d('2026-10-15T10:00:00.000Z'),
        confirmedAt: null,
      },
      {
        expenseId: 'ex_a',
        kind: 'pay',
        status: 'confirmed',
        amountMinor: 120_000n,
        occurredAt: d('2026-10-16T10:00:00.000Z'),
        confirmedAt: d('2026-10-16T10:00:00.000Z'),
      },
      {
        expenseId: 'ex_a',
        kind: 'deliver',
        status: 'confirmed',
        amountMinor: 150_000n,
        occurredAt: d('2026-10-20T07:00:00.000Z'),
        confirmedAt: d('2026-10-20T07:00:00.000Z'),
      },
      // Неизвестная оплата не двигает суммы.
      {
        expenseId: 'ex_a',
        kind: 'pay',
        status: 'unknown',
        amountMinor: 30_000n,
        occurredAt: d('2026-11-01T10:00:00.000Z'),
        confirmedAt: null,
      },
      {
        expenseId: 'ex_tools',
        kind: 'deliver',
        status: 'confirmed',
        amountMinor: 20_000n,
        occurredAt: d('2026-10-10T10:00:00.000Z'),
        confirmedAt: d('2026-10-10T10:00:00.000Z'),
      },
      {
        expenseId: 'ex_tools',
        kind: 'pay',
        status: 'confirmed',
        amountMinor: 20_000n,
        occurredAt: d('2026-10-10T10:00:00.000Z'),
        confirmedAt: d('2026-10-10T10:00:00.000Z'),
      },
      // Обязательство месяца AI: касса 500 грн, оказано 500 грн, экономика —
      // по вызовам (счёт месяца в экономику НЕ входит — иначе AI дважды).
      {
        expenseId: 'ex_ai',
        kind: 'pay',
        status: 'confirmed',
        amountMinor: 50_000n,
        occurredAt: d('2026-11-01T10:00:00.000Z'),
        confirmedAt: d('2026-11-01T10:00:00.000Z'),
      },
      {
        expenseId: 'ex_ai',
        kind: 'deliver',
        status: 'confirmed',
        amountMinor: 50_000n,
        occurredAt: d('2026-11-30T10:00:00.000Z'),
        confirmedAt: d('2026-11-30T10:00:00.000Z'),
      },
    ],
    timeEntries: [
      {
        minutes: 120,
        role: 'analyst',
        rateMinorPerHour: 30_000n,
        isInvestment: false,
        workDate: '2026-11-02',
      },
      {
        minutes: 600,
        role: 'admin',
        rateMinorPerHour: 30_000n,
        isInvestment: true,
        workDate: '2026-10-05',
      },
      {
        minutes: 120,
        role: 'editor',
        rateMinorPerHour: null,
        isInvestment: false,
        workDate: '2026-11-03',
      },
    ],
    aiCalls: [
      {
        costMicroUsd: 1_000_000n,
        costStatus: 'priced',
        requestedAt: d('2026-11-01T10:00:00.000Z'),
      },
      {
        costMicroUsd: 1_000_000n,
        costStatus: 'priced',
        requestedAt: d('2026-11-01T10:05:00.000Z'),
      },
      {
        costMicroUsd: null,
        costStatus: 'unpriced',
        requestedAt: d('2026-11-01T10:10:00.000Z'),
      },
    ],
    rates: { approved: false, rates: {} },
    aiFxRate: '41.5',
    allowedCplInputs: {
      contributionMinor: null,
      pPayBp: null,
      shareBp: null,
      approved: false,
    },
    cacWindow: { until: 't72', days: null },
    searchDays: [],
    integrations: [
      {
        kind: 'events_collector',
        status: 'connected',
        manual: true,
        lastSuccessAt: d('2026-12-31T07:00:00.000Z'),
        staleAfterHours: 48,
      },
      {
        kind: 'web_analytics',
        status: 'connected',
        manual: true,
        lastSuccessAt: d('2026-12-31T07:00:00.000Z'),
        staleAfterHours: 48,
      },
    ],
  };
  return { ...base, ...over };
}
