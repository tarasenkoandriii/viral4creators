/**
 * AI Publisher (P-G2) — клиенты маршрутов денег, заявок и отчётов
 * (`src/lib/publisher/{distribution,leads,reports}-api.ts`) против
 * замороженных контрактов бэкенда (`sites-backend/src/modules/publisher/
 * contracts/*-api.ts`, `states.ts`), как `ai-api.test.ts` читает исходники:
 *  1. перечни — как у сервера;
 *  2. ключи разобранных ответов = ключи интерфейсов контракта;
 *  3. каждый вызов клиента — существующий маршрут контракта (метод+путь),
 *     `opKey` — только в теле мутаций;
 *  4. строгость: чужая форма → `PUB_RESPONSE_INVALID`; контакт в списке
 *     заявок → ошибка, не показ; «неизвестно» не становится нулём.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ApiError } from '../src/kit';
import type { PublisherHttp, Query } from '../src/lib/publisher/common-api';
import * as D from '../src/lib/publisher/distribution-api';
import * as L from '../src/lib/publisher/leads-api';
import * as R from '../src/lib/publisher/reports-api';
import { ALL, bodyIssues, bodyKeys, routesOf } from './publisher-contract-lib';
import {
  experimentVersionBody,
  placementStepRequest,
  type PlacementUiStep,
} from '../src/lib/publisher/ops-view';

const BACK = '../../sites-backend/src/modules/publisher/contracts/';
const src = (f: string) =>
  readFileSync(new URL(`${BACK}${f}`, import.meta.url), 'utf8');
const STATES = src('states.ts');
const DIST = src('distribution-api.ts');
const LEADS = src('leads-api.ts');
const REPORTS = src('reports-api.ts');

function constList(file: string, name: string): string[] {
  const m = file.match(
    new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const`)
  );
  assert.ok(m, `нет ${name}`);
  return [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

// ═══ 1. Перечни ═════════════════════════════════════════════════════════
const same = (mine: readonly string[], file: string, name: string) =>
  assert.deepEqual([...mine], constList(file, name), name);
same(D.CHANNEL_KINDS, STATES, 'CHANNEL_KINDS');
same(D.CHANNEL_STATUSES, STATES, 'CHANNEL_STATUSES');
same(D.DISTRIBUTION_STATUSES, STATES, 'DISTRIBUTION_STATUSES');
same(D.DISTRIBUTION_BLOCK_REASONS, STATES, 'DISTRIBUTION_BLOCK_REASONS');
same(D.PUBLICATION_STAGES, STATES, 'PUBLICATION_STAGES');
same(D.PUBLICATION_STATUSES, STATES, 'PUBLICATION_STATUSES');
same(D.PUBLICATION_VERIFY_STATUSES, STATES, 'PUBLICATION_VERIFY_STATUSES');
same(D.VENUE_LINK_MARKINGS, STATES, 'VENUE_LINK_MARKINGS');
same(D.VENUE_STATUSES, STATES, 'VENUE_STATUSES');
same(D.VENUE_CRITERIA, STATES, 'VENUE_CRITERIA');
same(D.PLACEMENT_STATUSES, STATES, 'PLACEMENT_STATUSES');
same(D.PAYMENT_STATUSES, STATES, 'PAYMENT_STATUSES');
same(D.CLAIM_STATUSES_PLACEMENT, STATES, 'CLAIM_STATUSES_PLACEMENT');
same(D.EXPENSE_CATEGORIES, STATES, 'EXPENSE_CATEGORIES');
same(D.EXPENSE_STATUSES, STATES, 'EXPENSE_STATUSES');
same(D.EXPENSE_ENTRY_KINDS, STATES, 'EXPENSE_ENTRY_KINDS');
same(D.EXPENSE_ENTRY_STATUSES, STATES, 'EXPENSE_ENTRY_STATUSES');
same(D.RESERVE_CATEGORIES, STATES, 'RESERVE_CATEGORIES');
same(L.LEAD_STATUSES, STATES, 'LEAD_STATUSES');
same(L.LEAD_TEST_REASONS, STATES, 'LEAD_TEST_REASONS');
same(L.CONTACT_METHODS, STATES, 'CONTACT_METHODS');
same(L.LEAD_REASON_CODES, STATES, 'LEAD_REASON_CODES');
same(L.CHANNEL_GROUPS, STATES, 'CHANNEL_GROUPS');
same(L.PRIOR_EXTERNAL_PAYMENT, STATES, 'PRIOR_EXTERNAL_PAYMENT');
same(L.PAYMENT_RECORD_TYPES, STATES, 'PAYMENT_RECORD_TYPES');
same(L.PAYER_KINDS, STATES, 'PAYER_KINDS');
same(L.CLIENT_PAYMENT_STATUSES, STATES, 'CLIENT_PAYMENT_STATUSES');
same(L.NEW_CUSTOMER_VALUES, STATES, 'NEW_CUSTOMER_VALUES');
same(L.NOTIFICATION_KINDS, STATES, 'NOTIFICATION_KINDS');
same(L.NOTIFICATION_STATUSES, STATES, 'NOTIFICATION_STATUSES');
same(L.OUTBOX_STATUSES, STATES, 'OUTBOX_STATUSES');
same(L.EVENT_NAMES, STATES, 'EVENT_NAMES');
same(L.LEAD_TEST_FILTERS, LEADS, 'LEAD_TEST_FILTERS');
same(L.CONTACT_PURPOSES, LEADS, 'CONTACT_PURPOSES');
same(R.PUB_ROLES, STATES, 'PUB_ROLES');
same(R.TIME_ENTRY_CATEGORIES, STATES, 'TIME_ENTRY_CATEGORIES');
same(R.INTEGRATION_KINDS, STATES, 'INTEGRATION_KINDS');
same(R.INTEGRATION_STATUSES, STATES, 'INTEGRATION_STATUSES');
same(R.METRIC_IMPORT_SOURCES, STATES, 'METRIC_IMPORT_SOURCES');
same(R.EXPERIMENT_KINDS, STATES, 'EXPERIMENT_KINDS');
same(R.EXPERIMENT_STATUSES, STATES, 'EXPERIMENT_STATUSES');
same(R.EXPERIMENT_CONCLUSIONS, STATES, 'EXPERIMENT_CONCLUSIONS');
same(R.EXPERIMENT_DECISIONS, STATES, 'EXPERIMENT_DECISIONS');
same(R.REPORT_KINDS, STATES, 'REPORT_KINDS');
same(R.REPORT_RECOMPUTE_REASONS, STATES, 'REPORT_RECOMPUTE_REASONS');
same(R.BACKUP_KINDS, STATES, 'BACKUP_KINDS');
same(R.BACKUP_STATUSES, STATES, 'BACKUP_STATUSES');
same(R.RESTORE_MODES, STATES, 'RESTORE_MODES');
same(R.RESTORE_STATUSES, STATES, 'RESTORE_STATUSES');
// Причина пересчёта от человека — только `manual` (контракт
// `RecomputeReportBody.reason?: 'manual'`, P-E S3-10).
{
  const m = REPORTS.match(/RecomputeReportBody[\s\S]*?reason\??:\s*([^;]+);/);
  assert.ok(m, 'RecomputeReportBody.reason');
  assert.deepEqual(
    [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1]),
    [...R.RECOMPUTE_REASONS_MANUAL]
  );
}
// Шаги закупки — пути маршрутов `placements/:id/<шаг>` контракта.
for (const s of D.PLACEMENT_STEPS) {
  assert.ok(DIST.includes(`placements/:id/${s}\``), `шаг ${s}`);
}
// Предупреждения бюджета — из `BudgetView.warnings`.
{
  const m = DIST.match(/warnings: Array<([\s\S]*?)>;/);
  assert.ok(m);
  assert.deepEqual(
    [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1]),
    [...D.BUDGET_WARNINGS]
  );
}

// ═══ 2. Ключи ответов = ключи контракта ════════════════════════════════
/** Ключи верхнего уровня интерфейса (с наследованием внутри файла). */
function keysOf(file: string, name: string): string[] {
  const re = new RegExp(
    `export interface ${name}(?:<[^>]*>)?(?:\\s+extends\\s+([\\w<>, ]+))?\\s*\\{`
  );
  const m = re.exec(file);
  assert.ok(m, `нет интерфейса ${name}`);
  let i = m!.index + m![0].length;
  let depth = 1;
  const start = i;
  while (depth > 0 && i < file.length) {
    const c = file[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    i++;
  }
  const body = file.slice(start, i - 1);
  const own = [...body.matchAll(/^ {2}(\w+)\??:/gm)].map((x) => x[1]);
  const parents = (m![1] ?? '')
    .split(',')
    .map((s) => s.trim().replace(/<.*$/, ''))
    .filter((s) => s && new RegExp(`export interface ${s}\\b`).test(file));
  return [
    ...new Set([...parents.flatMap((p) => keysOf(file, p)), ...own]),
  ].sort();
}
const keys = (o: object) => Object.keys(o).sort();

const ISO = '2026-10-20T07:00:00.000Z';

const venue = {
  id: 'v1',
  title: 'Forum',
  url: 'https://forum.example',
  topic: 'saas',
  market: 'UA',
  language: 'uk',
  audienceNote: null,
  formats: ['post'],
  criteria: {
    topic: { score: 2, why: 'ok' },
    format: { score: null, why: '' },
  },
  score: { sum: 2, max: 2, known: 1 },
  completeness: 1,
  checks: {
    topicMarket: true,
    priceConfirmed: false,
    formatConfirmed: false,
    termSet: false,
    supplierKnown: true,
  },
  linkMarking: 'unknown',
  riskNote: null,
  rejectReason: null,
  status: 'candidate',
  evidence: [{ id: 'e1', criterion: 'topic', sourceId: 's1', checkedAt: ISO }],
  missingForVerified: ['checks.priceConfirmed', 'linkMarking'],
  revision: 3,
};
const placement = {
  id: 'p1',
  venueId: 'v1',
  versionId: 'ver1',
  campaignId: 'c1',
  placementCode: 'pl-1',
  issuedUrl: 'https://site/x?utm_content=pl-1',
  purchaseSeq: 1,
  basePriceMinor: '100000',
  feesMinor: '5000',
  totalPriceMinor: '105000',
  currency: 'UAH',
  orig: {
    currency: 'USD',
    amountMinor: '2500',
    fxRate: '42.00000000',
    fxSource: 'NBU',
    fxAt: ISO,
  },
  priceConfirmedAt: ISO,
  priceSource: 'invoice',
  offerExpiresAt: null,
  terms: 'post',
  externalOrderId: null,
  status: 'approved',
  paymentStatus: 'unknown',
  paymentPartial: false,
  approvalId: 'a1',
  expenseId: null,
  reportDecisionId: null,
  publishDueAt: null,
  publishedAt: null,
  verifiedAt: null,
  claimStatus: 'none',
  claimOwnerMemberId: null,
  nextActionAt: null,
  observationOk: true,
  priceSnapshotHash: 'f'.repeat(64),
  revision: 2,
};
const entry = {
  id: 'en1',
  kind: 'pay',
  amountMinor: '1000',
  status: 'unknown',
  externalRef: null,
  sourceDocument: null,
  note: null,
  occurredAt: ISO,
  confirmedAt: null,
  confirmedBy: null,
  createdBy: 'member:m1',
};
const expense = {
  id: 'x1',
  category: 'placements',
  description: 'Forum post',
  placementId: 'p1',
  amountTotalMinor: '105000',
  paidMinor: '0',
  refundedMinor: '0',
  cancelledMinor: '0',
  deliveredMinor: '0',
  openCommitmentMinor: '105000',
  deliveredUnpaidMinor: '0',
  currency: 'UAH',
  orig: null,
  sourceDocument: null,
  reconcileRequired: true,
  paymentStatus: 'unknown',
  paymentPartial: false,
  status: 'open',
  entries: [entry],
  revision: 4,
};
const budget = {
  built: true,
  currency: 'UAH',
  total: '1000000',
  netPaid: '200000',
  openCommitment: '100000',
  deliveredUnpaid: '40000',
  protectedReserve: '200000',
  available: '500000',
  usageBp: 3000,
  warn: false,
  stopped: false,
  reconcileStopped: false,
  perPurchaseMax: '200000',
  byCategory: {
    placements: { used: '300000', limit: '600000', available: '300000' },
    tools: { used: '0', limit: '200000', available: '200000' },
  },
  cash: { paid: '200000', economicDelivered: '240000', advances: '0' },
  warnings: ['reconcile_required'],
  paramVersion: 2,
  reserveMoves: [
    {
      id: 'rm1',
      toCategory: 'tools',
      amountMinor: '50000',
      approvalId: 'ap',
      movedAt: ISO,
    },
  ],
};
const leadItem = {
  id: 'l1',
  publicRef: 'L-0001',
  status: 'new',
  receivedAt: ISO,
  contactMethod: 'email',
  budgetRange: null,
  selfReportedChannel: null,
  testFlag: false,
  testReason: null,
  suspectedSpam: false,
  responsibleMemberId: null,
  responsibleDisplayName: null,
  prospectId: null,
  prospectCode: null,
  duplicateOfLeadId: null,
  campaignId: null,
  contentId: null,
  placementId: null,
  contactDueAt: null,
  overdue: false,
  reviewDueAt: ISO,
  closedAt: null,
  erased: false,
  enriched: false,
  revision: 1,
};
const leadCard = {
  ...leadItem,
  consentState: 'granted',
  sessionRef: null,
  contentSlugRaw: null,
  placementCodeRaw: null,
  attribution: {
    model: 'last_non_direct_30d',
    last: null,
    first: null,
    coverage: 'unknown',
  },
  enrichedAt: null,
  retentionBasis: null,
  erasedAt: null,
  decisions: [
    {
      id: 'd1',
      fromStatus: 'new',
      toStatus: 'contacted',
      reasonCode: null,
      hasNote: true,
      confirmedInterestAt: null,
      decidedBy: 'member:m',
      decidedAt: ISO,
      supersedesId: null,
    },
  ],
  prospectLinks: [
    {
      prospectId: 'pr1',
      prospectCode: 'P-0001',
      validFrom: ISO,
      reason: 'new',
      decidedBy: 'system:lead-enrich',
    },
  ],
  possibleDuplicates: ['l2'],
  outbox: { status: 'done', attempts: 1, lastErrorCode: null },
  notifications: [
    { id: 'n1', kind: 'new_lead', status: 'sent', recipientMemberId: 'm1' },
  ],
};
const contact = {
  leadId: 'l1',
  publicRef: 'L-0001',
  name: 'Синтетичний',
  contactMethod: 'email',
  contact: 'synthetic@example.invalid',
  business: null,
  task: 'задача',
  selfReported: null,
};
const notes = {
  leadId: 'l1',
  decisions: [
    { decisionId: 'd1', toStatus: 'contacted', decidedAt: ISO, note: 'n' },
  ],
  prospect: null,
};
const prospect = {
  id: 'pr1',
  code: 'P-0001',
  isExternal: true,
  isTeamOrPartner: false,
  priorExternalPayment: 'unknown',
  mergedIntoId: null,
  hasNote: false,
  leadIds: ['l1'],
  createdAt: ISO,
  revision: 1,
};
const payment = {
  id: 'pay1',
  prospectId: 'pr1',
  leadId: 'l1',
  recordType: 'payment_received',
  payerKind: 'external',
  amountMinor: '500000',
  currency: 'UAH',
  occurredAt: ISO,
  paymentRef: 'INV-1',
  confirmation: null,
  status: 'pending',
  confirmedBy: null,
  confirmedAt: null,
  isNewCustomer: 'unknown',
  revenue: false,
  createdAt: ISO,
};
const notification = {
  id: 'n1',
  leadId: 'l1',
  leadRef: 'L-0001',
  kind: 'new_lead',
  recipientMemberId: 'm1',
  status: 'failed',
  attempts: 2,
  nextAttemptAt: ISO,
  lastErrorCode: 'TG_403',
  sentAt: null,
  createdAt: ISO,
};
const outbox = {
  id: 'o1',
  leadId: 'l1',
  leadRef: 'L-0001',
  status: 'failed',
  attempts: 3,
  lastErrorCode: 'X',
  createdAt: ISO,
  updatedAt: ISO,
};
const queueCheck = {
  id: 'q1',
  checkedBy: 'member:m',
  checkedAt: ISO,
  workDate: '2026-10-20',
  openCount: 2,
  overdueCount: 1,
};
const retention = {
  leadId: 'l1',
  publicRef: 'L-0001',
  status: 'rejected',
  reviewDueAt: ISO,
  closedAt: ISO,
  retentionBasis: null,
  responsibleMemberId: null,
  overdue: true,
};
const zeroDen = {
  kind: 'not_computable',
  reason: 'zero_denominator',
  inputs: { numeratorMinor: '340000', qualified: 0 },
};
const passport = {
  filter: { contentId: null, placementId: 'p1', from: null, to: null },
  publications: [
    {
      id: 'pb1',
      finalUrl: 'https://s/m/x',
      stage: 'live',
      status: 'published',
      publishedAt: ISO,
    },
  ],
  placement: {
    id: 'p1',
    placementCode: 'pl-1',
    status: 'published',
    publishedAt: ISO,
  },
  sessions: null,
  sessionMode: 'none',
  events: { content_view: 10, cta_click: 2, lead_submit_success: 0 },
  byChannel: { paid_placement: 10 },
  leads: { total: 0, test: 0, pendingEnrichment: 0 },
  qualified: { allExternal: 0, linked: 0, unknown: 0 },
  coverage: {
    kind: 'not_computable',
    reason: 'zero_denominator',
    inputs: { linked: 0, all: 0 },
  },
  directCpl: zeroDen,
  productCpl: zeroDen,
  currency: 'UAH',
};
const trafficEvent = {
  id: 'ev1',
  eventId: '1f6b0b8e-1d8a-4c3e-9b1a-0f6b0b8e1d8a',
  name: 'content_view',
  occurredAt: ISO,
  contentSlugRaw: 'x',
  placementCodeRaw: null,
  referrerHost: null,
  sessionRef: null,
  utm: { source: '[redacted]' },
  utmRedacted: true,
  contentId: null,
  placementId: null,
  channelGroup: null,
  leadId: null,
  testFlag: true,
  enrichedAt: null,
};
const timeEntry = {
  id: 't1',
  memberId: 'm1',
  memberDisplayName: 'M',
  role: 'editor',
  task: 'бриф',
  featureId: null,
  contentId: null,
  minutes: 90,
  rateMinorPerHour: null,
  rateParamVersion: null,
  workDate: '2026-10-20',
  category: 'production',
  isInvestment: false,
  createdAt: ISO,
  revision: 1,
};
const metricImport = {
  id: 'mi1',
  source: 'web_analytics',
  periodStart: ISO,
  periodEnd: ISO,
  granularity: 'kyiv_day',
  days: 7,
  importedBy: 'member:m',
  importedAt: ISO,
  fileRef: null,
  note: null,
};
const integration = {
  kind: 'web_analytics',
  exists: true,
  status: 'connected',
  manual: true,
  lastSuccessAt: ISO,
  lastCheckedAt: ISO,
  staleAfterHours: 48,
  stale: true,
  note: null,
  revision: 2,
};
const experiment = {
  id: 'e1',
  key: 'pilot',
  version: 1,
  kind: 'pilot',
  hypothesis: 'h',
  change: 'c',
  metric: 'm',
  expectedSignal: 's',
  stopConditions: 'x',
  baselineVersionId: null,
  newVersionId: null,
  windowStart: ISO,
  windowEnd: '2099-01-01T00:00:00.000Z',
  limitMinor: null,
  thresholds: null,
  t0Planned: ISO,
  t0: null,
  t42: null,
  t72: null,
  t90: null,
  lateCohortEnd: null,
  registeredAt: ISO,
  appliedAt: null,
  status: 'registered',
  conclusion: null,
  conclusionReason: null,
  decision: null,
  decidedBy: null,
  decidedAt: null,
  supersedesId: null,
  contentIds: [],
};
const reportSummary = {
  id: 'r1',
  kind: 'd42',
  periodStart: ISO,
  periodEnd: ISO,
  snapshotAt: ISO,
  experimentId: 'e1',
  inputsHash: 'a'.repeat(64),
  supersedesReportId: null,
  recomputeReason: null,
  decision: null,
  superseded: false,
  createdAt: ISO,
  createdBy: 'member:m',
};
const metrics = {
  sessions: {
    mode: 'imported_aggregate',
    value: null,
    partialDays: ['2026-10-21'],
    missingDays: [],
  },
  leads: {
    inPeriod: 0,
    linked: 0,
    pending: 2,
    qualifiedUnique: 0,
    linkedQualified: 0,
    unknownQualified: 0,
    coverage: zeroDen,
    proposalsToDistinct: 0,
  },
  qualifiedPer100Sessions: {
    basis: 'period_ratio',
    value: {
      kind: 'not_computable',
      reason: 'unknown_input',
      inputs: { sessions: null },
    },
  },
  windowClosed: false,
  signalD42: {
    verdict: 'inconclusive',
    parts: {
      sessions: { value: null, threshold: 300, state: 'unknown' },
      qualified: {
        value: 0,
        threshold: 3,
        state: 'not_met',
        linked: 0,
        unknown: 0,
      },
      proposals: { value: 0, threshold: 1, state: 'not_met' },
    },
  },
  searchSignalD90: null,
  economics: {
    directCpl: zeroDen,
    fullOperationalCplTechnical: zeroDen,
    productCpl: zeroDen,
    investmentCpl: zeroDen,
    allowedOperationalCpl: { kind: 'value', value: '166600' },
    economicSignal: {
      kind: 'not_computable',
      reason: 'zero_denominator',
      inputs: {},
    },
    operationalCac: {
      kind: 'not_computable',
      reason: 'zero_denominator',
      inputs: {
        numeratorMinor: '340000',
        numeratorLowerBound: 1,
        newPaying: 0,
      },
    },
    investmentCac: zeroDen,
    newPayingLinked: 0,
    newCustomerUnknown: 0,
    cacWindowEnd: ISO,
  },
  revenue: {
    byCurrency: {},
    externalPayingProspects: 0,
    contractsSigned: 0,
    excludedNonExternal: 1,
    commercialValidation: 'not_confirmed',
  },
  placements: [
    {
      id: 'p1',
      placementCode: 'pl-1',
      publishedAt: ISO,
      windowState: 'open',
      late: false,
      deliveredMinor: '105000',
      technicalQualified: 0,
      directCpl: zeroDen,
    },
  ],
  experimentConclusion: 'inconclusive_only',
  diagnostics: {
    testSessions: 0,
    testLeads: 1,
    testQualified: 0,
    teamOrPartnerQualified: 0,
    excludedPayments: 1,
  },
  membership: { leadIds: [], prospectIds: [] },
};
const costs = {
  currency: 'UAH',
  economic: {
    operational: {
      kind: 'value',
      value: '340000',
      lowerBound: true,
      unknownParts: ['labor:editor'],
    },
    investment: { kind: 'value', value: '0' },
    total: {
      kind: 'value',
      value: '340000',
      lowerBound: true,
      unknownParts: ['labor:editor'],
    },
  },
  cash: { netPaidMinor: '105000', advancesMinor: '0' },
  parts: {
    laborOperationalMinor: '0',
    laborInvestmentMinor: '0',
    placementsDeliveredMinor: '105000',
    toolsDeliveredMinor: '0',
    aiMinor: '235000',
    advancesMinor: '0',
    minutesWithoutRate: { operational: 90, investment: 0 },
    aiCallsUnpriced: 0,
  },
  window: { start: null, end: ISO },
};
const report = {
  ...reportSummary,
  cohort: {
    t0: ISO,
    t42: ISO,
    start: ISO,
    end: ISO,
    closeAt: ISO,
    lateCohortEnd: null,
    sessionMode: 'imported_aggregate',
    experimentId: 'e1',
    experimentVersion: 1,
  },
  attributionModel: 'last_non_direct_30d',
  sources: {
    integrations: [
      {
        kind: 'web_analytics',
        status: 'degraded',
        manual: true,
        lastSyncedAt: null,
        stale: false,
      },
    ],
    completeness: { state: 'partial', missing: ['integration:web_analytics'] },
  },
  metrics,
  costs,
  assumptions: null,
};
const backup = {
  id: 'b1',
  kind: 'manual',
  status: 'ok',
  sha256: 'b'.repeat(64),
  sizeBytes: '1024',
  tableCounts: { pub_leads: 3 },
  keyVersion: 'k1',
  rotationUntil: ISO,
  createdAt: ISO,
  createdBy: 'member:m',
};
const restore = {
  id: 'rs1',
  backupId: 'b1',
  mode: 'dry_run',
  targetProductId: null,
  status: 'running',
  report: { startedAt: ISO },
  startedBy: 'member:m',
  createdAt: ISO,
  updatedAt: ISO,
};

const check = (
  file: string,
  iface: string,
  decoded: object,
  opt: string[] = []
) => {
  const want = keysOf(file, iface);
  const got = keys(decoded);
  assert.deepEqual(
    got.filter((k) => !opt.includes(k)),
    want.filter((k) => !opt.includes(k)),
    iface
  );
};
check(DIST, 'VenueView', D.decodeVenue(venue));
check(DIST, 'PlacementView', D.decodePlacement(placement));
check(DIST, 'ExpenseEntryView', D.decodeEntry(entry));
check(DIST, 'ExpenseView', D.decodeExpense(expense));
check(DIST, 'BudgetView', D.decodeBudget(budget));
check(LEADS, 'LeadListItem', L.decodeLeadItem(leadItem));
check(LEADS, 'LeadCardView', L.decodeLeadCard(leadCard));
check(LEADS, 'LeadContactView', L.decodeContact(contact));
check(LEADS, 'LeadNotesView', L.decodeNotes(notes));
check(LEADS, 'ProspectView', L.decodeProspect(prospect));
check(LEADS, 'PaymentView', L.decodePayment(payment));
check(LEADS, 'NotificationView', L.decodeNotification(notification));
check(LEADS, 'OutboxView', L.decodeOutbox(outbox));
check(LEADS, 'QueueCheckView', L.decodeQueueCheck(queueCheck));
check(LEADS, 'RetentionDueItem', L.decodeRetentionItem(retention));
check(LEADS, 'TrafficPassport', L.decodePassport(passport));
check(LEADS, 'TrafficEventView', L.decodeTrafficEvent(trafficEvent));
check(REPORTS, 'TimeEntryView', R.decodeTimeEntry(timeEntry));
check(REPORTS, 'MetricImportView', R.decodeMetricImport(metricImport));
check(REPORTS, 'IntegrationView', R.decodeIntegration(integration));
check(REPORTS, 'ExperimentView', R.decodeExperiment(experiment));
check(REPORTS, 'ReportSummaryView', R.decodeReportSummary(reportSummary));
check(REPORTS, 'ReportView', R.decodeReport(report));
check(REPORTS, 'BackupView', R.decodeBackup(backup));
check(REPORTS, 'RestoreView', R.decodeRestore(restore));
check(
  LEADS,
  'PaymentsPage',
  L.decodePaymentsPage({
    items: [payment],
    nextBefore: null,
    summary: {
      revenueByCurrency: { UAH: '0' },
      nonRevenueCount: { internal: 1 },
      commercialValidation: false,
    },
  }),
  ['items', 'nextBefore']
);

// ═══ 3. Маршруты: метод + путь существуют в контракте; opKey — в теле ═══
type Call = {
  method: string;
  path: string;
  query?: Query;
  body?: Record<string, unknown>;
  opKey?: string;
  /** `PublisherHttp.reveal` — POST без opKey (раскрытие ПД). */
  reveal?: boolean;
};
const calls: Call[] = [];
// Подмена клиента оболочки: записывает вызовы; файловые методы (CSV и
// др.) экраны P-G2 зовут через `ListToolbar` оболочки, здесь не нужны.
const http = {
  async get<T>(path: string, query?: Query) {
    calls.push({ method: 'GET', path, query });
    return {} as T;
  },
  async send<T>(
    method: 'POST' | 'PATCH' | 'PUT',
    path: string,
    body?: Record<string, unknown>,
    opKey?: string
  ) {
    calls.push({ method, path, body, opKey });
    return {} as T;
  },
  async reveal<T>(path: string, body: Record<string, unknown>) {
    calls.push({ method: 'POST', path, body, reveal: true });
    return {} as T;
  },
  async csv() {
    return { filename: 'x.csv', text: '' };
  },
  async markdown() {
    return { filename: 'x.md', text: '' };
  },
} satisfies PublisherHttp;
const CONTENT = src('content-api.ts');
const ROUTES = [
  ...routesOf(DIST),
  ...routesOf(LEADS),
  ...routesOf(REPORTS),
  ...routesOf(CONTENT),
];
const OPK = '4b1f6c2e-8f0a-4c2b-9d3e-1a2b3c4d5e6f';
// Формы шагов, как их заполняет человек (все шаги и все исходы претензии).
const PL = {
  revision: 3,
  currency: 'UAH',
  totalPriceMinor: '105000',
  priceSnapshotHash: 'f'.repeat(64),
  purchaseSeq: 3,
};
const FORM: Record<string, string> = {
  reportDecisionId: 'r1',
  reason: 'причина',
  externalOrderId: 'ORD-1',
  note: 'n',
  publishDueAt: '2026-10-30T10:00',
  publishedAt: '2026-10-21T10:00',
  url: 'https://forum.example/post/1',
  linkUrl: 'https://site.example/m/x?utm_content=pl-1',
  evidenceUrl: 'https://web.archive.org/x',
  marking: 'sponsored',
  owner: 'm1',
  nextActionAt: '2026-10-25T10:00',
  document: 'Акт № 1',
};
const STEP_REQUESTS = [
  ...(
    [
      'approve',
      'reserve',
      'order',
      'publication',
      'published',
      'verify',
      'dispute',
      'cancel',
      'reject',
    ] as Exclude<PlacementUiStep, 'editPrice' | 'resolve'>[]
  ).map((st) =>
    placementStepRequest(st, PL, {
      fields: FORM,
      amountMinor: '0',
      versionHash: 'c'.repeat(64),
    })
  ),
  ...(['publication_pending', 'published', 'cancelled'] as const).map((to) =>
    placementStepRequest('resolve', PL, {
      fields: { ...FORM, to },
      amountMinor: '0',
    })
  ),
].map((q) => {
  assert.ok(q, 'шаг собран из полной формы');
  return q!;
});
// Проверка размещения без ссылки или доказательства — запроса нет (S1-1).
for (const k of ['linkUrl', 'evidenceUrl', 'marking', 'url']) {
  assert.equal(
    placementStepRequest('verify', PL, {
      fields: { ...FORM, [k]: '' },
    }),
    null,
    `verify без ${k}`
  );
}
assert.equal(
  placementStepRequest('verify', PL, {
    fields: { ...FORM, linkUrl: 'javascript:alert(1)' },
  }),
  null,
  'verify: ссылка не https'
);
// 3-я закупка без решения по отчёту — согласование не собирается.
assert.equal(
  placementStepRequest('approve', PL, {
    fields: { ...FORM, reportDecisionId: '' },
    versionHash: 'c',
  }),
  null
);

const d = D.createDistributionApi(http);
const l = L.createLeadsApi(http);
const r = R.createReportsApi(http);
const swallow = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    // Ответ подменён `{}` — ошибка разбора ожидаема; путь уже записан.
    assert.ok(e instanceof ApiError, 'только ошибка разбора');
  }
};
const P = 'pid1';
const body = { expectedRevision: 1 } as const;
await Promise.all(
  [
    d.venues(P, { status: 'verified' }),
    d.venue(P, 'v1'),
    d.createVenue(P, OPK, { title: 't', url: 'https://x' }),
    d.patchVenue(P, 'v1', OPK, 1, { riskNote: null }),
    d.venueTransition(P, 'v1', OPK, { ...body, to: 'verified' }),
    d.placements(P),
    d.placement(P, 'p1'),
    d.createPlacement(P, OPK, {
      venueId: 'v',
      versionId: 'ver',
      price: { currency: 'UAH', baseMinor: '1', feesMinor: '0' },
      priceSource: 's',
      terms: 't',
    }),
    d.patchPlacement(P, 'p1', OPK, 1, { terms: 'x' }),
    // Шаги закупки — телами, которые собирает экран (`placementStepRequest`).
    ...STEP_REQUESTS.map((q) =>
      d.placementStep(P, 'p1', q.step, OPK, q.body as never)
    ),
    d.expenses(P),
    d.expense(P, 'x1'),
    d.createExpense(P, OPK, {
      category: 'tools',
      description: 'd',
      amount: { currency: 'UAH', minor: '1' },
    }),
    d.createEntry(P, 'x1', OPK, {
      kind: 'pay',
      amountMinor: '1',
      status: 'unknown',
    }),
    d.reconcileEntry(P, 'x1', 'en1', OPK, {
      status: 'confirmed',
      document: 'doc',
    }),
    d.budget(P),
    d.rebuildCounters(P, OPK, 'основание пересборки счётчиков'),
    d.reserveRelease(P, OPK, {
      toCategory: 'tools',
      amountMinor: '1',
      basis: 'basis basis',
    }),
    d.versionApproval(P, 'ver1'),
    l.leads(P, { status: 'new', responsible: 'none', test: 'exclude' }),
    l.lead(P, 'l1'),
    l.revealContact(P, 'l1', 'first_contact'),
    l.revealNotes(P, 'l1'),
    l.transition(P, 'l1', OPK, { ...body, to: 'contacted' }),
    l.assign(P, 'l1', OPK, { ...body, responsibleMemberId: null }),
    l.testFlag(P, 'l1', OPK, { ...body, testFlag: true, reason: 'r' }),
    l.duplicate(P, 'l1', OPK, {
      ...body,
      duplicateOfLeadId: null,
      reason: 'r',
    }),
    l.setProspect(P, 'l1', OPK, { ...body, prospectId: 'new', reason: 'r' }),
    l.erase(P, 'l1', OPK, { ...body, basis: 'b' }),
    l.retain(P, 'l1', OPK, { ...body, basis: 'b', nextReviewAt: ISO }),
    l.prospects(P),
    l.createProspect(P, OPK, {}),
    l.updateProspect(P, 'pr1', OPK, { ...body, note: null }),
    l.mergeProspects(P, OPK, { fromId: 'a', intoId: 'b', reason: 'r' }),
    l.payments(P, { prospectId: 'pr1' }),
    l.createPayment(P, OPK, {
      prospectId: 'pr1',
      recordType: 'payment_received',
      payerKind: 'external',
      amountMinor: '1',
      currency: 'UAH',
      occurredAt: ISO,
      paymentRef: 'x',
    }),
    ...(['confirm', 'refund', 'cancel'] as const).map((s) =>
      l.paymentStep(P, 'pay1', s, OPK)
    ),
    l.notifications(P, 'failed'),
    l.retryNotification(P, 'n1', OPK),
    l.outbox(P),
    l.queueChecks(P),
    l.markQueueChecked(P, OPK),
    l.retentionDue(P),
    l.passport(P, { placementId: 'p1' }),
    l.events(P, { test: 'only' }),
    r.timeEntries(P, { member: 'm1' }),
    r.createTimeEntry(P, OPK, {
      role: 'editor',
      task: 't',
      minutes: 1,
      workDate: '2026-10-20',
      category: 'setup',
    }),
    r.patchTimeEntry(P, 't1', OPK, { ...body, minutes: 2 }),
    r.metricImports(P),
    r.createMetricImport(P, OPK, {
      source: 'manual',
      periodStart: ISO,
      periodEnd: ISO,
      payload: { days: [] },
    }),
    r.integrations(P),
    r.putIntegration(P, 'web_analytics', OPK, { status: 'connected' }),
    r.experiments(P),
    r.registerExperiment(P, OPK, {
      key: 'k',
      hypothesis: 'h',
      change: 'c',
      metric: 'm',
      expectedSignal: 's',
      stopConditions: 'x',
      windowStart: ISO,
      windowEnd: ISO,
    }),
    r.experimentVersion(
      P,
      'e1',
      OPK,
      experimentVersionBody(
        { kind: 'pilot', t0: ISO },
        { lateCohortEnd: '2027-01-10T10:00' },
        new Date(ISO)
      )!
    ),
    r.experimentVersion(
      P,
      'e2',
      OPK,
      experimentVersionBody(
        { kind: 'change', t0: null },
        { hypothesis: 'h2', windowStart: '2099-01-01T10:00' },
        new Date(ISO)
      )!
    ),
    r.applyExperiment(P, 'e1', OPK),
    r.concludeExperiment(P, 'e1', OPK, {
      conclusion: 'inconclusive',
      reason: 'r',
      decision: 'fix_stage',
    }),
    r.reports(P, { kind: 'd42' }),
    r.report(P, 'r1'),
    r.createReport(P, OPK, { kind: 'weekly' }),
    r.reportDecision(P, 'r1', OPK, 'go'),
    r.recomputeReport(P, 'r1', OPK, 'manual'),
    r.economicsPreview(P),
    r.backups(P),
    r.createBackup(P, OPK),
    r.restore(P, 'b1', OPK, { mode: 'dry_run' }),
    r.restoreStatus(P, 'rs1'),
  ].map(swallow)
);

assert.ok(calls.length >= 70, `вызовов ${calls.length}`);
let bodyChecked = 0;
for (const c of calls) {
  const full = `/publisher/${c.path}`;
  assert.ok(!c.path.startsWith('/'), `путь без ведущего слеша: ${c.path}`);
  const hit = ROUTES.find((x) => x.method === c.method && x.re.test(full));
  assert.ok(hit, `нет маршрута в контракте: ${c.method} ${full}`);
  if (c.method === 'GET') {
    assert.equal(c.opKey, undefined, `чтение без opKey: ${full}`);
  } else if (c.reveal) {
    // Раскрытие ПД — POST без opKey; тело = тип тела маршрута.
    assert.equal(c.opKey, undefined, `раскрытие без opKey: ${full}`);
    const issues = bodyIssues(c.body ?? {}, bodyKeys(hit!.body, ALL));
    assert.deepEqual(issues, [], `${c.method} ${hit!.path} (${hit!.body})`);
    bodyChecked++;
  } else {
    assert.equal(c.opKey, OPK, `мутация с opKey попытки: ${full}`);
    assert.ok(
      !('opKey' in (c.body ?? {})),
      'opKey кладёт PublisherHttp, а не клиент'
    );
    // Тело = `*Body` контракта: без лишних ключей, обязательные на месте.
    const issues = bodyIssues(c.body ?? {}, bodyKeys(hit!.body, ALL));
    assert.deepEqual(issues, [], `${c.method} ${hit!.path} (${hit!.body})`);
    bodyChecked++;
  }
}
// Каждый маршрут контрактов P-C/P-D/P-E вызван клиентом. Исключения:
// выключенные в P0 AI F09/F10 (409 `PUB_AI_DISABLED`) и календарь F09 —
// каналы, действия, ссылки, публикации (клиент P-G1 `calendar-api.ts`).
const CALENDAR = /\/(channels|distribution\/|utm$|publications)/;
for (const rt of [
  ...routesOf(DIST),
  ...routesOf(LEADS),
  ...routesOf(REPORTS),
]) {
  if (/distribution\/plan|venues\/compare/.test(rt.path)) continue;
  // Прежний GET раскрытия — 405 (Р-PUB-Z2-25): клиента нет и не должно быть.
  if (/GetRemoved$/.test(rt.name)) continue;
  if (CALENDAR.test(rt.path)) continue;
  assert.ok(
    calls.some(
      (c) => c.method === rt.method && rt.re.test(`/publisher/${c.path}`)
    ),
    `маршрут без клиента: ${rt.method} ${rt.path}`
  );
}
// Раскрытие контакта и заметок — POST без opKey (Р-PUB-Z2-25, D1-02),
// цель — в теле; GET раскрытия клиент не делает.
{
  const c = calls.find((x) => x.path.endsWith('/leads/l1/contact'));
  assert.ok(c && c.method === 'POST' && c.reveal && c.opKey === undefined);
  assert.deepEqual(c!.body, { purpose: 'first_contact' });
  const n = calls.find((x) => x.path.endsWith('/leads/l1/notes'));
  assert.ok(n && n.method === 'POST' && n.reveal);
  assert.ok(
    !calls.some(
      (x) =>
        x.method === 'GET' && /\/leads\/[^/]+\/(contact|notes)$/.test(x.path)
    ),
    'GET раскрытия'
  );
}

// ═══ 4. Строгость и «неизвестно ≠ 0» ═══════════════════════════════════
const invalid = (fn: () => unknown, what: string) => {
  let code = '';
  try {
    fn();
  } catch (e) {
    code = e instanceof ApiError ? e.code : 'other';
  }
  assert.equal(code, 'PUB_RESPONSE_INVALID', what);
};
invalid(
  () => D.decodeVenue({ ...venue, status: 'maybe' }),
  'чужой статус площадки'
);
invalid(
  () => D.decodeVenue({ ...venue, criteria: { topic: { score: 3, why: '' } } }),
  'оценка вне 0–2'
);
invalid(
  () => D.decodePlacement({ ...placement, totalPriceMinor: 1050 }),
  'сумма числом, а не строкой'
);
invalid(
  () => D.decodeBudget({ ...budget, warnings: ['all_good'] }),
  'чужое предупреждение бюджета'
);
invalid(
  () => L.decodeLeadItem({ ...leadItem, contact: 'x@y.z' }),
  'контакт в строке очереди'
);
invalid(
  () => L.decodeLeadCard({ ...leadCard, task: 'текст' }),
  'текст задачи в карточке'
);
invalid(
  () => L.decodeLeadItem({ ...leadItem, name: 'Ім’я' }),
  'имя в строке очереди'
);
invalid(
  () => L.decodePassport({ ...passport, coverage: { kind: 'value' } }),
  'Computable без значения'
);
invalid(
  () => R.decodePreview({ ...report, preliminary: false, at: ISO }),
  'предпросмотр без признака «предварительно»'
);
invalid(
  () =>
    R.decodeReport({
      ...report,
      sources: { integrations: [{ kind: 'x', status: 'ok' }] },
    }),
  'источник без статуса из списка'
);

// Неизвестное остаётся неизвестным.
{
  const v = D.decodeVenue(venue);
  assert.equal(v.criteria.format?.score, null, 'невідомо ≠ 0');
  const p = L.decodePassport(passport);
  assert.equal(p.sessions, null, 'сессии не измеряются — null, не 0');
  assert.equal(p.directCpl.kind, 'not_computable');
  const rep = R.decodeReport(report);
  assert.equal(rep.metrics.sessions?.value, null);
  assert.deepEqual(rep.metrics.sessions?.partialDays, ['2026-10-21']);
  assert.equal(rep.costs.operational?.kind, 'value');
  assert.equal(
    rep.costs.operational?.kind === 'value' && rep.costs.operational.lowerBound,
    true
  );
  assert.deepEqual(rep.costs.minutesWithoutRate, {
    operational: 90,
    investment: 0,
  });
  assert.equal(rep.sources.completeness?.state, 'partial');
  assert.equal(rep.sources.list[0].lastSyncedAt, null);
  // Старый снимок без частей — части `null`, а не нули.
  const old = R.decodeReport({
    ...reportSummary,
    cohort: {},
    attributionModel: 'last_non_direct_30d',
    sources: null,
    metrics: {},
    costs: {},
    assumptions: null,
  });
  assert.equal(old.metrics.leads, null);
  assert.equal(old.metrics.economics, null);
  assert.equal(old.costs.operational, null);
  assert.equal(old.sources.completeness, null);
  // Новые поля (P-B1/P-E): нет в снимке — `null` (неизвестно), не 0/false.
  assert.equal(rep.metrics.sessions?.complete ?? null, null);
  const fresh = R.decodeReport({
    ...report,
    metrics: {
      ...metrics,
      sessions: { ...metrics.sessions, complete: false },
      leads: {
        ...metrics.leads,
        outsideCohort: { nextPeriod: 1, afterSessionWindow: 2 },
      },
      placements: metrics.placements.map((x) => ({
        ...x,
        deliveryUnconfirmed: true,
      })),
    },
  });
  assert.equal(fresh.metrics.sessions?.complete, false);
  assert.deepEqual(fresh.metrics.leads?.outsideCohort, {
    nextPeriod: 1,
    afterSessionWindow: 2,
  });
  assert.equal(fresh.metrics.placements[0].deliveryUnconfirmed, true);
  assert.equal(rep.metrics.placements[0].deliveryUnconfirmed, null);
  assert.equal(p.leads.trapHitsLastHour, null, 'ловушка без данных — null');
  assert.equal(
    L.decodePassport({
      ...passport,
      leads: { ...passport.leads, trapHitsLastHour: 3 },
    }).leads.trapHitsLastHour,
    3
  );
  assert.equal(L.decodeContact(contact).dataNotice, null);
  assert.deepEqual(
    L.decodeContact({
      ...contact,
      dataNotice: { version: 'v3', expected: 'v4', matches: false },
    }).dataNotice,
    { version: 'v3', expected: 'v4', matches: false }
  );
  const t = R.decodeTimeEntry(timeEntry);
  assert.equal(t.rateMinorPerHour, null, 'ставка не утверждена — null');
  const i = R.decodeIntegration({
    ...integration,
    exists: false,
    revision: null,
    lastSuccessAt: null,
  });
  assert.equal(i.revision, null);
}

console.log(
  `publisher-ops-api: ok (${calls.length} calls, ${bodyChecked} bodies = *Body, ${ROUTES.length} routes)`
);
