/**
 * AI Publisher (P-G2): клиент маршрутов P-C — площадки F10, закупки и
 * расходы F12, бюджет (контракт
 * `sites-backend/src/modules/publisher/contracts/distribution-api.ts`).
 * Перечни и ключи ответов сверяет с исходником бэкенда
 * `scripts/publisher-ops-api.test.ts`. Каналы, календарь F09 и публикации
 * — клиент оболочки P-G1 (`calendar-api.ts`, экран `calendar`).
 */
import type { PublisherHttp } from './common-api';
import {
  arr,
  bad,
  bool,
  choice,
  int,
  items,
  minor,
  obj,
  page,
  productPath,
  seg,
  verbs,
  str,
  strList,
  strN,
  type ListPage,
} from './ops-decode';

// ── Перечни (зеркало contracts/states.ts) ────────────────────────────────

export const CHANNEL_KINDS = [
  'own',
  'community',
  'paid_venue',
  'site',
] as const;
export const CHANNEL_STATUSES = ['available', 'unavailable'] as const;
export const DISTRIBUTION_STATUSES = [
  'planned',
  'blocked',
  'done',
  'cancelled',
] as const;
export const DISTRIBUTION_BLOCK_REASONS = [
  'ads_not_allowed',
  'channel_unavailable',
  'content_stale',
  'source',
  'approval',
  'access',
  'measurement',
  'budget',
  'vendor',
  'no_venue',
  'other',
] as const;
export const PUBLICATION_STAGES = ['test', 'live'] as const;
export const PUBLICATION_STATUSES = [
  'pending',
  'published',
  'replaced',
  'failed',
  'withdrawn',
] as const;
export const PUBLICATION_VERIFY_STATUSES = [
  'not_checked',
  'ok',
  'mismatch',
  'unreachable',
] as const;
export const VENUE_LINK_MARKINGS = [
  'sponsored',
  'nofollow',
  'unknown',
] as const;
export const VENUE_STATUSES = ['candidate', 'verified', 'rejected'] as const;
export const VENUE_CRITERIA = [
  'topic',
  'geo_language',
  'format',
  'evidence_freshness',
  'real_distribution',
] as const;
export const PLACEMENT_STATUSES = [
  'proposed',
  'approved',
  'budget_reserved',
  'ordered',
  'publication_pending',
  'published',
  'verified_complete',
  'rejected',
  'cancelled',
  'disputed',
] as const;
export const PAYMENT_STATUSES = [
  'unpaid',
  'pending',
  'paid',
  'refunded',
  'unknown',
] as const;
export const CLAIM_STATUSES_PLACEMENT = ['none', 'open', 'resolved'] as const;
export const EXPENSE_CATEGORIES = ['placements', 'tools', 'other'] as const;
export const EXPENSE_STATUSES = ['open', 'closed'] as const;
export const EXPENSE_ENTRY_KINDS = [
  'commit',
  'pay',
  'refund',
  'cancel',
  'deliver',
  'adjust',
] as const;
export const EXPENSE_ENTRY_STATUSES = [
  'confirmed',
  'pending',
  'unknown',
  'void',
] as const;
export const BUDGET_WARNINGS = [
  'warn_80',
  'stopped_100',
  'reconcile_required',
  'reconcile_stopped',
  'stale_limit',
] as const;
export const RESERVE_CATEGORIES = ['placements', 'tools'] as const;

export type ChannelKind = (typeof CHANNEL_KINDS)[number];
export type ChannelStatus = (typeof CHANNEL_STATUSES)[number];
export type DistributionStatus = (typeof DISTRIBUTION_STATUSES)[number];
export type DistributionBlockReason =
  (typeof DISTRIBUTION_BLOCK_REASONS)[number];
export type PublicationStage = (typeof PUBLICATION_STAGES)[number];
export type PublicationStatus = (typeof PUBLICATION_STATUSES)[number];
export type PublicationVerifyStatus =
  (typeof PUBLICATION_VERIFY_STATUSES)[number];
export type VenueLinkMarking = (typeof VENUE_LINK_MARKINGS)[number];
export type VenueStatus = (typeof VENUE_STATUSES)[number];
export type VenueCriterion = (typeof VENUE_CRITERIA)[number];
export type PlacementStatus = (typeof PLACEMENT_STATUSES)[number];
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];
export type ExpenseEntryKind = (typeof EXPENSE_ENTRY_KINDS)[number];
export type ExpenseEntryStatus = (typeof EXPENSE_ENTRY_STATUSES)[number];
export type BudgetWarning = (typeof BUDGET_WARNINGS)[number];
export type ReserveCategory = (typeof RESERVE_CATEGORIES)[number];

// ── Виды ответов ─────────────────────────────────────────────────────────

export interface CriterionScore {
  /** null — «невідомо»: не усредняется и не считается положительным. */
  score: 0 | 1 | 2 | null;
  why: string;
}
export interface VenueEvidenceView {
  id: string;
  criterion: VenueCriterion;
  sourceId: string;
  checkedAt: string;
}
export interface VenueChecks {
  topicMarket: boolean;
  priceConfirmed: boolean;
  formatConfirmed: boolean;
  termSet: boolean;
  supplierKnown: boolean;
}
export const VENUE_CHECK_KEYS = [
  'topicMarket',
  'priceConfirmed',
  'formatConfirmed',
  'termSet',
  'supplierKnown',
] as const satisfies readonly (keyof VenueChecks)[];
export interface VenueView {
  id: string;
  title: string;
  url: string;
  topic: string | null;
  market: string | null;
  language: string | null;
  audienceNote: string | null;
  formats: unknown;
  criteria: Partial<Record<VenueCriterion, CriterionScore>>;
  score: { sum: number; max: number; known: number };
  completeness: number;
  checks: VenueChecks;
  linkMarking: VenueLinkMarking;
  riskNote: string | null;
  rejectReason: string | null;
  status: VenueStatus;
  evidence: VenueEvidenceView[];
  missingForVerified: string[];
  revision: number;
}
export interface OrigPrice {
  currency: string;
  amountMinor: string;
  fxRate: string;
  fxSource: string;
  fxAt: string;
}
export interface PlacementView {
  id: string;
  venueId: string;
  versionId: string;
  campaignId: string;
  placementCode: string;
  issuedUrl: string | null;
  purchaseSeq: number;
  basePriceMinor: string;
  feesMinor: string;
  totalPriceMinor: string;
  currency: string;
  orig: OrigPrice | null;
  priceConfirmedAt: string | null;
  priceSource: string | null;
  offerExpiresAt: string | null;
  terms: string | null;
  externalOrderId: string | null;
  status: PlacementStatus;
  paymentStatus: PaymentStatus;
  paymentPartial: boolean;
  approvalId: string | null;
  expenseId: string | null;
  reportDecisionId: string | null;
  publishDueAt: string | null;
  publishedAt: string | null;
  verifiedAt: string | null;
  claimStatus: 'none' | 'open' | 'resolved';
  claimOwnerMemberId: string | null;
  nextActionAt: string | null;
  observationOk: boolean;
  priceSnapshotHash: string;
  revision: number;
}
export interface ExpenseEntryView {
  id: string;
  kind: ExpenseEntryKind;
  amountMinor: string;
  status: ExpenseEntryStatus;
  externalRef: string | null;
  sourceDocument: string | null;
  note: string | null;
  occurredAt: string;
  confirmedAt: string | null;
  confirmedBy: string | null;
  createdBy: string;
}
export interface ExpenseView {
  id: string;
  category: ExpenseCategory;
  description: string;
  placementId: string | null;
  amountTotalMinor: string;
  paidMinor: string;
  refundedMinor: string;
  cancelledMinor: string;
  deliveredMinor: string;
  openCommitmentMinor: string;
  deliveredUnpaidMinor: string;
  currency: string;
  orig: OrigPrice | null;
  sourceDocument: string | null;
  reconcileRequired: boolean;
  paymentStatus: PaymentStatus;
  paymentPartial: boolean;
  status: 'open' | 'closed';
  /** Нет в списке — только в карточке (`GET expenses/:id`). */
  entries?: ExpenseEntryView[];
  revision: number;
}
export interface BudgetCategoryView {
  used: string;
  limit: string;
  available: string;
}
export interface BudgetView {
  built: boolean;
  currency: string | null;
  total: string;
  netPaid: string;
  openCommitment: string;
  deliveredUnpaid: string;
  protectedReserve: string;
  available: string;
  usageBp: number;
  warn: boolean;
  stopped: boolean;
  reconcileStopped: boolean;
  perPurchaseMax: string;
  byCategory: Record<ReserveCategory, BudgetCategoryView>;
  cash: { paid: string; economicDelivered: string; advances: string };
  warnings: BudgetWarning[];
  paramVersion: number;
  reserveMoves: Array<{
    id: string;
    toCategory: ReserveCategory;
    amountMinor: string;
    approvalId: string;
    movedAt: string;
  }>;
}

// ── Декодеры ─────────────────────────────────────────────────────────────

function criterionScore(v: unknown): CriterionScore {
  const o = obj(v, 'criterion');
  const s = o.score;
  if (!(s === null || s === 0 || s === 1 || s === 2)) {
    return bad('criterion.score');
  }
  return { score: s, why: typeof o.why === 'string' ? o.why : '' };
}

function origPrice(v: unknown): OrigPrice | null {
  if (v === null || v === undefined) return null;
  const o = obj(v, 'orig');
  return {
    currency: str(o.currency),
    amountMinor: minor(o.amountMinor),
    fxRate: str(o.fxRate),
    fxSource: str(o.fxSource),
    fxAt: str(o.fxAt),
  };
}

export function decodeVenue(v: unknown): VenueView {
  const o = obj(v, 'venue');
  const criteria: VenueView['criteria'] = {};
  for (const [k, x] of Object.entries(obj(o.criteria ?? {}, 'criteria'))) {
    criteria[choice(k, VENUE_CRITERIA, 'criteria.key')] = criterionScore(x);
  }
  const sc = obj(o.score, 'venue.score');
  const ch = obj(o.checks, 'venue.checks');
  return {
    id: str(o.id),
    title: str(o.title),
    url: str(o.url),
    topic: strN(o.topic),
    market: strN(o.market),
    language: strN(o.language),
    audienceNote: strN(o.audienceNote),
    formats: o.formats ?? null,
    criteria,
    score: { sum: int(sc.sum), max: int(sc.max), known: int(sc.known) },
    completeness: int(o.completeness),
    checks: {
      topicMarket: bool(ch.topicMarket),
      priceConfirmed: bool(ch.priceConfirmed),
      formatConfirmed: bool(ch.formatConfirmed),
      termSet: bool(ch.termSet),
      supplierKnown: bool(ch.supplierKnown),
    },
    linkMarking: choice(o.linkMarking, VENUE_LINK_MARKINGS, 'linkMarking'),
    riskNote: strN(o.riskNote),
    rejectReason: strN(o.rejectReason),
    status: choice(o.status, VENUE_STATUSES, 'venue.status'),
    evidence: arr(o.evidence ?? [], 'evidence').map((x) => {
      const e = obj(x, 'evidence');
      return {
        id: str(e.id),
        criterion: choice(e.criterion, VENUE_CRITERIA, 'evidence.criterion'),
        sourceId: str(e.sourceId),
        checkedAt: str(e.checkedAt),
      };
    }),
    missingForVerified: strList(o.missingForVerified ?? []),
    revision: int(o.revision),
  };
}

export function decodePlacement(v: unknown): PlacementView {
  const o = obj(v, 'placement');
  return {
    id: str(o.id),
    venueId: str(o.venueId),
    versionId: str(o.versionId),
    campaignId: str(o.campaignId),
    placementCode: str(o.placementCode),
    issuedUrl: strN(o.issuedUrl),
    purchaseSeq: int(o.purchaseSeq),
    basePriceMinor: minor(o.basePriceMinor),
    feesMinor: minor(o.feesMinor),
    totalPriceMinor: minor(o.totalPriceMinor),
    currency: str(o.currency),
    orig: origPrice(o.orig),
    priceConfirmedAt: strN(o.priceConfirmedAt),
    priceSource: strN(o.priceSource),
    offerExpiresAt: strN(o.offerExpiresAt),
    terms: strN(o.terms),
    externalOrderId: strN(o.externalOrderId),
    status: choice(o.status, PLACEMENT_STATUSES, 'placement.status'),
    paymentStatus: choice(o.paymentStatus, PAYMENT_STATUSES, 'paymentStatus'),
    paymentPartial: bool(o.paymentPartial),
    approvalId: strN(o.approvalId),
    expenseId: strN(o.expenseId),
    reportDecisionId: strN(o.reportDecisionId),
    publishDueAt: strN(o.publishDueAt),
    publishedAt: strN(o.publishedAt),
    verifiedAt: strN(o.verifiedAt),
    claimStatus: choice(o.claimStatus, CLAIM_STATUSES_PLACEMENT, 'claim'),
    claimOwnerMemberId: strN(o.claimOwnerMemberId),
    nextActionAt: strN(o.nextActionAt),
    observationOk: bool(o.observationOk),
    priceSnapshotHash: str(o.priceSnapshotHash),
    revision: int(o.revision),
  };
}

export function decodeEntry(v: unknown): ExpenseEntryView {
  const o = obj(v, 'entry');
  return {
    id: str(o.id),
    kind: choice(o.kind, EXPENSE_ENTRY_KINDS, 'entry.kind'),
    amountMinor: minor(o.amountMinor),
    status: choice(o.status, EXPENSE_ENTRY_STATUSES, 'entry.status'),
    externalRef: strN(o.externalRef),
    sourceDocument: strN(o.sourceDocument),
    note: strN(o.note),
    occurredAt: str(o.occurredAt),
    confirmedAt: strN(o.confirmedAt),
    confirmedBy: strN(o.confirmedBy),
    createdBy: str(o.createdBy),
  };
}

export function decodeExpense(v: unknown): ExpenseView {
  const o = obj(v, 'expense');
  return {
    id: str(o.id),
    category: choice(o.category, EXPENSE_CATEGORIES, 'expense.category'),
    description: str(o.description),
    placementId: strN(o.placementId),
    amountTotalMinor: minor(o.amountTotalMinor),
    paidMinor: minor(o.paidMinor),
    refundedMinor: minor(o.refundedMinor),
    cancelledMinor: minor(o.cancelledMinor),
    deliveredMinor: minor(o.deliveredMinor),
    openCommitmentMinor: minor(o.openCommitmentMinor),
    deliveredUnpaidMinor: minor(o.deliveredUnpaidMinor),
    currency: str(o.currency),
    orig: origPrice(o.orig),
    sourceDocument: strN(o.sourceDocument),
    reconcileRequired: bool(o.reconcileRequired),
    paymentStatus: choice(o.paymentStatus, PAYMENT_STATUSES, 'paymentStatus'),
    paymentPartial: bool(o.paymentPartial),
    status: choice(o.status, EXPENSE_STATUSES, 'expense.status'),
    ...(o.entries === undefined
      ? {}
      : { entries: arr(o.entries, 'entries').map(decodeEntry) }),
    revision: int(o.revision),
  };
}

function category(v: unknown): BudgetCategoryView {
  const o = obj(v, 'budget.category');
  return {
    used: minor(o.used),
    limit: minor(o.limit),
    available: minor(o.available),
  };
}

export function decodeBudget(v: unknown): BudgetView {
  const o = obj(v, 'budget');
  const bc = obj(o.byCategory, 'byCategory');
  const cash = obj(o.cash, 'cash');
  return {
    built: bool(o.built),
    currency: strN(o.currency),
    total: minor(o.total),
    netPaid: minor(o.netPaid),
    openCommitment: minor(o.openCommitment),
    deliveredUnpaid: minor(o.deliveredUnpaid),
    protectedReserve: minor(o.protectedReserve),
    available: minor(o.available),
    usageBp: int(o.usageBp),
    warn: bool(o.warn),
    stopped: bool(o.stopped),
    reconcileStopped: bool(o.reconcileStopped),
    perPurchaseMax: minor(o.perPurchaseMax),
    byCategory: {
      placements: category(bc.placements),
      tools: category(bc.tools),
    },
    cash: {
      paid: minor(cash.paid),
      economicDelivered: minor(cash.economicDelivered),
      advances: minor(cash.advances),
    },
    warnings: arr(o.warnings, 'warnings').map((w) =>
      choice(w, BUDGET_WARNINGS, 'warning')
    ),
    paramVersion: int(o.paramVersion),
    reserveMoves: arr(o.reserveMoves, 'reserveMoves').map((x) => {
      const m = obj(x, 'reserveMove');
      return {
        id: str(m.id),
        toCategory: choice(m.toCategory, RESERVE_CATEGORIES, 'toCategory'),
        amountMinor: minor(m.amountMinor),
        approvalId: str(m.approvalId),
        movedAt: str(m.movedAt),
      };
    }),
  };
}

// ── Тела запросов (contracts/distribution-api.ts) ────────────────────────

export interface QuotedPrice {
  currency: string;
  baseMinor: string;
  feesMinor: string;
}
export interface FxInput {
  rate: string;
  source: string;
  at: string;
}
export interface VenueBody {
  title?: string;
  url?: string;
  topic?: string | null;
  market?: string | null;
  language?: string | null;
  audienceNote?: string | null;
  criteria?: Partial<Record<VenueCriterion, CriterionScore>>;
  checks?: Partial<VenueChecks>;
  linkMarking?: VenueLinkMarking;
  riskNote?: string | null;
  evidence?: Array<{
    criterion: VenueCriterion;
    sourceId: string;
    checkedAt: string;
  }>;
}
export interface CreatePlacementInput {
  venueId: string;
  versionId: string;
  price: QuotedPrice;
  fx?: FxInput;
  priceSource: string;
  priceConfirmedAt?: string;
  offerExpiresAt?: string | null;
  terms: string;
  targetUrl?: string;
}
export interface CreateEntryInput {
  kind: 'pay' | 'refund' | 'deliver' | 'adjust' | 'cancel';
  amountMinor: string;
  status?: 'confirmed' | 'pending' | 'unknown';
  externalRef?: string;
  sourceDocument?: string;
  note?: string;
  occurredAt?: string;
  approvalId?: string;
}
export interface ListFilter {
  status?: string;
  owner?: string;
  before?: string;
  limit?: number;
  [k: string]: string | number | undefined;
}

// ── Клиент ───────────────────────────────────────────────────────────────

export function createDistributionApi(http: PublisherHttp) {
  const P = productPath;
  const { get, post, patch } = verbs(http);
  return {
    // Площадки F10
    venues: async (
      pid: string,
      f: ListFilter = {}
    ): Promise<ListPage<VenueView>> =>
      page(await get(`${P(pid)}/venues`, f), decodeVenue),
    venue: async (pid: string, id: string) =>
      decodeVenue(await get(`${P(pid)}/venues/${seg(id)}`)),
    createVenue: async (
      pid: string,
      opKey: string,
      body: VenueBody & { title: string; url: string }
    ) => decodeVenue(await post(`${P(pid)}/venues`, { ...body }, opKey)),
    /**
     * AI-сравнение площадок (`pub.venues.compare`). В P0 генератор выключен:
     * сервер всегда отвечает 409 `PUB_AI_DISABLED` (ручной путь — таблица
     * сравнения); ответ тела нет — экран разбирает его как старт AI.
     */
    aiCompareVenues: async (pid: string, opKey: string, venueIds: string[]) =>
      http.send<unknown>(
        'POST',
        `${P(pid)}/venues/compare`,
        { venueIds: [...venueIds] },
        opKey
      ),
    patchVenue: async (
      pid: string,
      id: string,
      opKey: string,
      expectedRevision: number,
      body: VenueBody
    ) =>
      decodeVenue(
        await patch(
          `${P(pid)}/venues/${seg(id)}`,
          { expectedRevision, ...body },
          opKey
        )
      ),
    venueTransition: async (
      pid: string,
      id: string,
      opKey: string,
      body: {
        expectedRevision: number;
        to: 'verified' | 'rejected' | 'candidate';
        reason?: string;
      }
    ) =>
      decodeVenue(
        await post(`${P(pid)}/venues/${seg(id)}/transition`, { ...body }, opKey)
      ),

    // Закупки F12
    placements: async (pid: string, f: ListFilter = {}) =>
      page(await get(`${P(pid)}/placements`, f), decodePlacement),
    placement: async (pid: string, id: string) =>
      decodePlacement(await get(`${P(pid)}/placements/${seg(id)}`)),
    createPlacement: async (
      pid: string,
      opKey: string,
      body: CreatePlacementInput
    ) =>
      decodePlacement(await post(`${P(pid)}/placements`, { ...body }, opKey)),
    patchPlacement: async (
      pid: string,
      id: string,
      opKey: string,
      expectedRevision: number,
      body: {
        price?: QuotedPrice;
        fx?: FxInput | null;
        priceSource?: string;
        priceConfirmedAt?: string;
        offerExpiresAt?: string | null;
        terms?: string;
      }
    ) =>
      decodePlacement(
        await patch(
          `${P(pid)}/placements/${seg(id)}`,
          { expectedRevision, ...body },
          opKey
        )
      ),
    /**
     * Шаг машины 7.2: `approve | reserve | order | publication | published
     * | verify | dispute | dispute/resolve | cancel | reject`. Тело —
     * `expectedRevision` и поля шага (contracts/distribution-api.ts).
     */
    placementStep: async <S extends PlacementStep>(
      pid: string,
      id: string,
      step: S,
      opKey: string,
      body: PlacementStepIn[S]
    ) =>
      decodePlacement(
        await post(
          `${P(pid)}/placements/${seg(id)}/${step}`,
          { ...body },
          opKey
        )
      ),

    /**
     * Действующее согласование публикации версии (маршрут P-B1
     * `GET approvals?objectId&status=active`): hash для согласования
     * закупки. Нет — `null` (закупку согласовать нельзя).
     */
    versionApproval: async (pid: string, versionId: string) => {
      const list = items(
        await get(`${P(pid)}/approvals`, {
          objectId: versionId,
          status: 'active',
        }),
        (x) => {
          const a = obj(x, 'approval');
          return {
            id: str(a.id),
            objectId: str(a.objectId),
            versionHash: str(a.versionHash),
            status: str(a.status),
          };
        }
      );
      return (
        list.find((a) => a.objectId === versionId && a.status === 'active') ??
        null
      );
    },

    // Расходы
    expenses: async (pid: string, f: ListFilter = {}) =>
      page(await get(`${P(pid)}/expenses`, f), decodeExpense),
    expense: async (pid: string, id: string) =>
      decodeExpense(await get(`${P(pid)}/expenses/${seg(id)}`)),
    createExpense: async (
      pid: string,
      opKey: string,
      body: {
        category: 'tools' | 'other';
        description: string;
        amount: { currency: string; minor: string };
        fx?: FxInput;
        sourceDocument?: string;
      }
    ) => decodeExpense(await post(`${P(pid)}/expenses`, { ...body }, opKey)),
    createEntry: async (
      pid: string,
      expenseId: string,
      opKey: string,
      body: CreateEntryInput
    ) =>
      decodeExpense(
        await post(
          `${P(pid)}/expenses/${seg(expenseId)}/entries`,
          { ...body },
          opKey
        )
      ),
    reconcileEntry: async (
      pid: string,
      expenseId: string,
      entryId: string,
      opKey: string,
      body: { status: 'confirmed' | 'void'; document: string }
    ) =>
      decodeExpense(
        await post(
          `${P(pid)}/expenses/${seg(expenseId)}/entries/${seg(entryId)}/reconcile`,
          { ...body },
          opKey
        )
      ),

    // Бюджет
    budget: async (pid: string) => decodeBudget(await get(`${P(pid)}/budget`)),
    /**
     * Пересборка счётчиков бюджета из записей (P-C S2-4): единственный путь
     * снять `counters_mismatch`; решение PO, основание ≥ 10 символов, аудит.
     */
    rebuildCounters: async (pid: string, opKey: string, basis: string) =>
      decodeBudget(
        await post(`${P(pid)}/budget/rebuild-counters`, { basis }, opKey)
      ),
    reserveRelease: async (
      pid: string,
      opKey: string,
      body: { toCategory: ReserveCategory; amountMinor: string; basis: string }
    ) =>
      decodeBudget(
        await post(`${P(pid)}/budget/reserve-release`, { ...body }, opKey)
      ),
  };
}

export const PLACEMENT_STEPS = [
  'approve',
  'reserve',
  'order',
  'publication',
  'published',
  'verify',
  'dispute',
  'dispute/resolve',
  'cancel',
  'reject',
] as const;
export type PlacementStep = (typeof PLACEMENT_STEPS)[number];

type Rev = { expectedRevision: number };
/**
 * Тела шагов машины 7.2 — зеркало `*Body` contracts/distribution-api.ts без
 * `opKey` (сверка ключей — `scripts/publisher-bodies.test.ts`).
 */
export interface PlacementStepIn {
  approve: Rev & {
    maxAmountMinor: string;
    currency: string;
    versionHash: string;
    priceSnapshotHash: string;
    reportDecisionId?: string;
    reason?: string;
  };
  reserve: Rev;
  order: Rev & { externalOrderId: string; note?: string };
  publication: Rev & { publishDueAt: string };
  published: Rev & { url: string; publishedAt: string };
  verify: Rev & {
    url: string;
    linkUrl: string;
    evidenceUrl: string;
    marking: 'sponsored' | 'nofollow';
  };
  dispute: Rev & {
    claimOwnerMemberId: string;
    nextActionAt: string;
    reason: string;
  };
  'dispute/resolve': Rev & {
    to: 'publication_pending' | 'published' | 'cancelled';
    reason: string;
    confirmedAmountMinor?: string;
    document?: string;
    publishDueAt?: string;
    url?: string;
    publishedAt?: string;
  };
  cancel: Rev & { confirmedAmountMinor: string; document: string };
  reject: Rev & { reason: string };
}

export type DistributionApi = ReturnType<typeof createDistributionApi>;
