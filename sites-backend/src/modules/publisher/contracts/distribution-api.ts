/**
 * AI Publisher — контракт маршрутов P-C (проектный документ §11.3
 * «P-C — распространение, площадки, закупки, бюджет»; F09, F10, F12; ТЗ
 * §17). Заполнен по `_template.ts`; тест `distribution/distribution-api.spec.ts`
 * сверяет `DISTRIBUTION_ROUTES` с контроллерами (метод, путь, действие).
 *
 * Суммы — `MinorJson` (строка цифр в минимальных единицах), даты — ISO.
 * Читаемое имя канала и площадки в API — `title` (колонка `name`): ключ
 * `name` запрещён в ответах мутаций триггером ключа идемпотентности
 * (Р-PUB-A1-13), а ответы P-C хранятся целиком (Р-PUB-C-3).
 */
import { route } from './_template';
import type {
  ListPage,
  MinorJson,
  MutationBody,
  RevisionedBody,
} from './common';
import type {
  CHANNEL_KINDS,
  CHANNEL_STATUSES,
  DISTRIBUTION_BLOCK_REASONS,
  DistributionStatus,
  ExpenseCategory,
  EXPENSE_ENTRY_KINDS,
  EXPENSE_ENTRY_STATUSES,
  PlacementPaymentStatus,
  PlacementStatus,
  PUBLICATION_STAGES,
  PUBLICATION_VERIFY_STATUSES,
  PublicationReportKind,
  PublicationStatus,
  VENUE_CRITERIA,
  VENUE_LINK_MARKINGS,
  VenueStatus,
} from './states';

// Типы закрытых списков, которых нет в `states.ts` (он заморожен, §16.2):
// выводятся из тех же массивов — расхождения быть не может.
export type ChannelKind = (typeof CHANNEL_KINDS)[number];
export type ChannelStatus = (typeof CHANNEL_STATUSES)[number];
export type DistributionBlockReason =
  (typeof DISTRIBUTION_BLOCK_REASONS)[number];
export type ExpenseEntryKind = (typeof EXPENSE_ENTRY_KINDS)[number];
export type ExpenseEntryStatus = (typeof EXPENSE_ENTRY_STATUSES)[number];
export type PaymentStatus = PlacementPaymentStatus;
export type PublicationStage = (typeof PUBLICATION_STAGES)[number];
export type PublicationVerifyStatus =
  (typeof PUBLICATION_VERIFY_STATUSES)[number];
export type VenueCriterion = (typeof VENUE_CRITERIA)[number];
export type VenueLinkMarking = (typeof VENUE_LINK_MARKINGS)[number];
export type {
  DistributionStatus,
  ExpenseCategory,
  PlacementStatus,
  PublicationReportKind,
  PublicationStatus,
  VenueStatus,
};

// ── Каналы ───────────────────────────────────────────────────────────────

export interface ChannelView {
  id: string;
  code: string;
  title: string;
  kind: ChannelKind;
  utmSource: string;
  utmMedium: string;
  adsAllowed: boolean | null;
  rulesNote: string | null;
  status: ChannelStatus;
  revision: number;
}
export interface CreateChannelBody extends MutationBody {
  code: string;
  title: string;
  /** `site` создаётся вместе с продуктом и вторым не заводится. */
  kind: Exclude<ChannelKind, 'site'>;
  utmSource: string;
  utmMedium: string;
  adsAllowed?: boolean | null;
  rulesNote?: string | null;
}
export interface PatchChannelBody extends RevisionedBody {
  title?: string;
  utmSource?: string;
  utmMedium?: string;
  adsAllowed?: boolean | null;
  rulesNote?: string | null;
  status?: ChannelStatus;
}

// ── Календарь F09 ────────────────────────────────────────────────────────

export interface DistributionActionView {
  id: string;
  versionId: string;
  contentId: string;
  channelId: string;
  format: string;
  goal: string;
  plannedAt: string;
  ownerMemberId: string;
  ownerDisplayName: string;
  status: DistributionStatus;
  blockReason: DistributionBlockReason | null;
  /** С UTM для внешних каналов, без UTM для канала `site`. */
  measurableUrl: string;
  publicationId: string | null;
  /** Реальный URL выполненного действия (из публикации) или null. */
  doneUrl: string | null;
  revision: number;
}
export interface CreateActionBody extends MutationBody {
  versionId: string;
  channelId: string;
  format: string;
  goal: string;
  plannedAt: string;
  ownerMemberId: string;
  ownerDisplayName?: string;
  /** Адрес назначения (https); по умолчанию — страница материала на сайте. */
  targetUrl?: string;
}
export interface ActionTransitionBody extends RevisionedBody {
  to: 'blocked' | 'done' | 'cancelled' | 'planned';
  reason?: DistributionBlockReason;
  /** Обязателен для `done`: публикация той же версии в том же канале. */
  publicationId?: string;
}

export interface UtmLinkView {
  url: string;
  utm: { source: string; medium: string; campaign: string; content?: string };
}

// ── Публикации ───────────────────────────────────────────────────────────

export interface PublicationView {
  id: string;
  versionId: string;
  channelId: string;
  approvalId: string;
  stage: PublicationStage;
  finalUrl: string;
  publishedAt: string | null;
  status: PublicationStatus;
  verifyStatus: PublicationVerifyStatus;
  evidenceUrl: string | null;
  lastVerifiedAt: string | null;
  verifiedBy: string | null;
  verifyResult: string | null;
  /**
   * P-R M2 (Р-RD-10): `user_reported` — отчёт человека о ручной публикации
   * Reddit-материала (проверки нет и не будет, `verify` → 409 manual_only).
   */
  reportKind: PublicationReportKind;
  revision: number;
}
export interface CreatePublicationBody extends MutationBody {
  versionId: string;
  channelId: string;
  /** Для канала `site` строится от slug и `domain_host`; иначе обязателен. */
  finalUrl?: string;
  /** true — запись «ожидает публикации» (`pending`), иначе `published`. */
  pending?: boolean;
}
export interface VerifyPublicationBody extends RevisionedBody {
  result: 'ok' | 'mismatch' | 'unreachable';
  evidenceUrl?: string;
  note?: string;
}
export interface PublicationTransitionBody extends RevisionedBody {
  to: 'published' | 'failed' | 'withdrawn';
  reason?: string;
}

// ── Площадки F10 ─────────────────────────────────────────────────────────

export interface CriterionScore {
  /** null — неизвестно: не усредняется и не считается положительным. */
  score: 0 | 1 | 2 | null;
  why: string;
}
export interface VenueEvidenceView {
  id: string;
  criterion: VenueCriterion;
  sourceId: string;
  checkedAt: string;
}
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
  /** Балл — сумма ИЗВЕСТНЫХ оценок из максимума известных (эвристика, не прогноз). */
  score: { sum: number; max: number; known: number };
  /** Полнота отдельно от балла: сколько из пяти критериев оценено. */
  completeness: number;
  checks: {
    topicMarket: boolean;
    priceConfirmed: boolean;
    formatConfirmed: boolean;
    termSet: boolean;
    supplierKnown: boolean;
  };
  linkMarking: VenueLinkMarking;
  riskNote: string | null;
  rejectReason: string | null;
  status: VenueStatus;
  evidence: VenueEvidenceView[];
  /** Чего не хватает до `verified` (пусто — можно проверять). */
  missingForVerified: string[];
  revision: number;
}
export interface VenueBody {
  title?: string;
  url?: string;
  topic?: string | null;
  market?: string | null;
  language?: string | null;
  audienceNote?: string | null;
  formats?: unknown;
  criteria?: Partial<Record<VenueCriterion, CriterionScore>>;
  checks?: Partial<VenueView['checks']>;
  linkMarking?: VenueLinkMarking;
  riskNote?: string | null;
  /** Новые доказательства критериев (источники продукта). */
  evidence?: Array<{
    criterion: VenueCriterion;
    sourceId: string;
    checkedAt: string;
  }>;
}
export type CreateVenueBody = MutationBody &
  VenueBody & { title: string; url: string };
export type PatchVenueBody = RevisionedBody & VenueBody;
export interface VenueTransitionBody extends RevisionedBody {
  to: 'verified' | 'rejected' | 'candidate';
  reason?: string;
}

// ── Закупки F12 ──────────────────────────────────────────────────────────

/** Цена, как её назвал поставщик (с комиссиями — отдельной суммой). */
export interface QuotedPrice {
  currency: string;
  baseMinor: MinorJson;
  /** Обязательна (0 — явно «без комиссий»): цена без комиссий не окончательная. */
  feesMinor: MinorJson;
}
/** Курс «единиц валюты лимита за единицу валюты цены» (Decimal(18,8)). */
export interface FxInput {
  rate: string;
  source: string;
  at: string;
}
export interface PlacementView {
  id: string;
  venueId: string;
  versionId: string;
  campaignId: string;
  placementCode: string;
  issuedUrl: string | null;
  purchaseSeq: number;
  basePriceMinor: MinorJson;
  feesMinor: MinorJson;
  totalPriceMinor: MinorJson;
  currency: string;
  orig: {
    currency: string;
    amountMinor: MinorJson;
    fxRate: string;
    fxSource: string;
    fxAt: string;
  } | null;
  priceConfirmedAt: string | null;
  priceSource: string | null;
  offerExpiresAt: string | null;
  terms: string | null;
  externalOrderId: string | null;
  status: PlacementStatus;
  paymentStatus: PaymentStatus;
  /** Частичная оплата (ожидается доплата), §6.4. */
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
  /** Текущий снимок цены (sha256) — передаётся в согласование. */
  priceSnapshotHash: string;
  revision: number;
}
export interface CreatePlacementBody extends MutationBody {
  venueId: string;
  versionId: string;
  price: QuotedPrice;
  fx?: FxInput;
  priceSource: string;
  priceConfirmedAt?: string;
  offerExpiresAt?: string | null;
  terms: string;
  placementCode?: string;
  /** Адрес назначения выданной ссылки; по умолчанию — страница материала. */
  targetUrl?: string;
}
export interface PatchPlacementBody extends RevisionedBody {
  price?: QuotedPrice;
  fx?: FxInput | null;
  priceSource?: string;
  priceConfirmedAt?: string;
  offerExpiresAt?: string | null;
  terms?: string;
}
export interface ApprovePlacementBody extends RevisionedBody {
  maxAmountMinor: MinorJson;
  currency: string;
  versionHash: string;
  priceSnapshotHash: string;
  /** Для третьей и следующих закупок — снимок отчёта с решением (ТЗ §13). */
  reportDecisionId?: string;
  reason?: string;
}
export interface OrderBody extends RevisionedBody {
  /** Номер заказа поставщика (идентификатор, может состоять из цифр). */
  externalOrderId: string;
  note?: string;
}
export interface AwaitPublicationBody extends RevisionedBody {
  publishDueAt: string;
}
/**
 * URL размещения — на площадке закупки (хост/поддомен и путь карточки);
 * записывается публикацией в канале `paid-venues` (S1-2).
 */
export interface PlacementPublishedBody extends RevisionedBody {
  url: string;
  publishedAt: string;
}
/**
 * Проверка размещения (S1-2): `url` — записанный при `published`;
 * `linkUrl` — ссылка, найденная на странице (utm_content = placementCode,
 * кампания и адрес назначения выданной ссылки); `evidenceUrl` — снимок
 * или архивная копия страницы; `marking` — обещанная площадкой.
 */
export interface PlacementVerifyBody extends RevisionedBody {
  url: string;
  linkUrl: string;
  evidenceUrl: string;
  marking: 'sponsored' | 'nofollow';
}
export interface DisputeBody extends RevisionedBody {
  claimOwnerMemberId: string;
  nextActionAt: string;
  reason: string;
}
export interface ResolveDisputeBody extends RevisionedBody {
  to: 'publication_pending' | 'published' | 'cancelled';
  reason: string;
  /** Для `cancelled`: подтверждённо отменённая сумма и документ. */
  confirmedAmountMinor?: MinorJson;
  document?: string;
  /** Для `publication_pending`: новый срок. */
  publishDueAt?: string;
  /** Для `published`. */
  url?: string;
  publishedAt?: string;
}
export interface CancelPlacementBody extends RevisionedBody {
  /** ≥ 0: '0' — заказ снят без освобождения (оплаченный — возврат записью refund). */
  confirmedAmountMinor: MinorJson;
  document: string;
}
export interface RejectPlacementBody extends RevisionedBody {
  reason: string;
}

// ── Расходы и записи движения ────────────────────────────────────────────

export interface ExpenseEntryView {
  id: string;
  kind: ExpenseEntryKind;
  amountMinor: MinorJson;
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
  amountTotalMinor: MinorJson;
  paidMinor: MinorJson;
  refundedMinor: MinorJson;
  cancelledMinor: MinorJson;
  deliveredMinor: MinorJson;
  /** Вычисляемые (не хранятся в голове, §6.4). */
  openCommitmentMinor: MinorJson;
  deliveredUnpaidMinor: MinorJson;
  currency: string;
  orig: PlacementView['orig'];
  sourceDocument: string | null;
  reconcileRequired: boolean;
  paymentStatus: PaymentStatus;
  paymentPartial: boolean;
  status: 'open' | 'closed';
  entries?: ExpenseEntryView[];
  revision: number;
}
export interface CreateExpenseBody extends MutationBody {
  category: 'tools' | 'other';
  description: string;
  amount: { currency: string; minor: MinorJson };
  fx?: FxInput;
  sourceDocument?: string;
}
export interface CreateEntryBody extends MutationBody {
  kind: 'pay' | 'refund' | 'deliver' | 'adjust' | 'cancel';
  /** `adjust` — со знаком; остальные > 0. */
  amountMinor: MinorJson;
  /**
   * `pay`: confirmed | pending | unknown; `refund`: confirmed | pending
   * (pending — обещанный возврат, деньги не двигает); остальные — confirmed.
   */
  status?: 'confirmed' | 'pending' | 'unknown';
  externalRef?: string;
  sourceDocument?: string;
  note?: string;
  occurredAt?: string;
  /** Положительная корректировка закупки — новое согласование purchase. */
  approvalId?: string;
}
export interface ReconcileEntryBody extends MutationBody {
  status: 'confirmed' | 'void';
  document: string;
}

// ── Бюджет ───────────────────────────────────────────────────────────────

export interface BudgetView {
  built: boolean;
  currency: string | null;
  total: MinorJson;
  netPaid: MinorJson;
  openCommitment: MinorJson;
  /** Внутри openCommitment — второй раз не вычитается (ТЗ §17). */
  deliveredUnpaid: MinorJson;
  protectedReserve: MinorJson;
  available: MinorJson;
  usageBp: number;
  warn: boolean;
  stopped: boolean;
  /** Остановка новых обязательств ежедневной сверкой (задача владельцу). */
  reconcileStopped: boolean;
  perPurchaseMax: MinorJson;
  byCategory: Record<
    'placements' | 'tools',
    { used: MinorJson; limit: MinorJson; available: MinorJson }
  >;
  cash: { paid: MinorJson; economicDelivered: MinorJson; advances: MinorJson };
  warnings: Array<
    | 'warn_80'
    | 'stopped_100'
    | 'reconcile_required'
    | 'reconcile_stopped'
    | 'stale_limit'
  >;
  paramVersion: number;
  reserveMoves: Array<{
    id: string;
    toCategory: 'placements' | 'tools';
    amountMinor: MinorJson;
    approvalId: string;
    movedAt: string;
  }>;
}
export interface ReserveReleaseBody extends MutationBody {
  toCategory: 'placements' | 'tools';
  amountMinor: MinorJson;
  basis: string;
}
/** Пересборка счётчиков бюджета из записей (решение PO, Р-PUB-C-4). */
export interface RebuildCountersBody extends MutationBody {
  /** Основание, ≥ 10 символов. */
  basis: string;
}

const P = '/publisher/products/:pid';

export const DISTRIBUTION_ROUTES = {
  // Каналы
  listChannels: route<void, { items: ChannelView[] }>({
    method: 'GET',
    path: `${P}/channels`,
    action: 'product.read',
    mutation: false,
    status: 200,
  }),
  createChannel: route<CreateChannelBody, ChannelView>({
    method: 'POST',
    path: `${P}/channels`,
    action: 'channel.manage',
    mutation: true,
    status: 201,
  }),
  patchChannel: route<PatchChannelBody, ChannelView>({
    method: 'PATCH',
    path: `${P}/channels/:id`,
    action: 'channel.manage',
    mutation: true,
    status: 200,
  }),
  // Календарь F09
  aiPlan: route<MutationBody & { contentId: string }, never>({
    method: 'POST',
    path: `${P}/distribution/plan`,
    action: 'distribution.manage',
    mutation: true,
    status: 409,
  }),
  listActions: route<void, ListPage<DistributionActionView>>({
    method: 'GET',
    path: `${P}/distribution/actions`,
    action: 'product.read',
    mutation: false,
    status: 200,
  }),
  createAction: route<CreateActionBody, DistributionActionView>({
    method: 'POST',
    path: `${P}/distribution/actions`,
    action: 'distribution.manage',
    mutation: true,
    status: 201,
  }),
  actionTransition: route<ActionTransitionBody, DistributionActionView>({
    method: 'POST',
    path: `${P}/distribution/actions/:id/transition`,
    action: 'distribution.manage',
    mutation: true,
    status: 200,
  }),
  utm: route<void, UtmLinkView>({
    method: 'GET',
    path: `${P}/utm`,
    action: 'distribution.manage',
    mutation: false,
    status: 200,
  }),
  // Публикации
  listPublications: route<void, ListPage<PublicationView>>({
    method: 'GET',
    path: `${P}/publications`,
    action: 'product.read',
    mutation: false,
    status: 200,
  }),
  createPublication: route<CreatePublicationBody, PublicationView>({
    method: 'POST',
    path: `${P}/publications`,
    action: 'publication.manage',
    mutation: true,
    status: 201,
  }),
  verifyPublication: route<VerifyPublicationBody, PublicationView>({
    method: 'POST',
    path: `${P}/publications/:id/verify`,
    action: 'publication.manage',
    mutation: true,
    status: 200,
  }),
  publicationTransition: route<PublicationTransitionBody, PublicationView>({
    method: 'POST',
    path: `${P}/publications/:id/transition`,
    action: 'publication.manage',
    mutation: true,
    status: 200,
  }),
  // Площадки F10
  listVenues: route<void, ListPage<VenueView>>({
    method: 'GET',
    path: `${P}/venues`,
    action: 'product.read',
    mutation: false,
    status: 200,
  }),
  getVenue: route<void, VenueView>({
    method: 'GET',
    path: `${P}/venues/:id`,
    action: 'product.read',
    mutation: false,
    status: 200,
  }),
  createVenue: route<CreateVenueBody, VenueView>({
    method: 'POST',
    path: `${P}/venues`,
    action: 'venue.manage',
    mutation: true,
    status: 201,
  }),
  patchVenue: route<PatchVenueBody, VenueView>({
    method: 'PATCH',
    path: `${P}/venues/:id`,
    action: 'venue.manage',
    mutation: true,
    status: 200,
  }),
  venueTransition: route<VenueTransitionBody, VenueView>({
    method: 'POST',
    path: `${P}/venues/:id/transition`,
    action: 'venue.manage',
    mutation: true,
    status: 200,
  }),
  aiCompareVenues: route<MutationBody & { venueIds: string[] }, never>({
    method: 'POST',
    path: `${P}/venues/compare`,
    action: 'venue.manage',
    mutation: true,
    status: 409,
  }),
  // Закупки F12
  listPlacements: route<void, ListPage<PlacementView>>({
    method: 'GET',
    path: `${P}/placements`,
    action: 'product.read',
    mutation: false,
    status: 200,
  }),
  getPlacement: route<void, PlacementView>({
    method: 'GET',
    path: `${P}/placements/:id`,
    action: 'product.read',
    mutation: false,
    status: 200,
  }),
  createPlacement: route<CreatePlacementBody, PlacementView>({
    method: 'POST',
    path: `${P}/placements`,
    action: 'placement.propose',
    mutation: true,
    status: 201,
  }),
  patchPlacement: route<PatchPlacementBody, PlacementView>({
    method: 'PATCH',
    path: `${P}/placements/:id`,
    action: 'placement.propose',
    mutation: true,
    status: 200,
  }),
  approvePlacement: route<ApprovePlacementBody, PlacementView>({
    method: 'POST',
    path: `${P}/placements/:id/approve`,
    action: 'placement.approve',
    mutation: true,
    status: 200,
  }),
  reservePlacement: route<RevisionedBody, PlacementView>({
    method: 'POST',
    path: `${P}/placements/:id/reserve`,
    action: 'budget.operate',
    mutation: true,
    status: 200,
  }),
  orderPlacement: route<OrderBody, PlacementView>({
    method: 'POST',
    path: `${P}/placements/:id/order`,
    action: 'budget.operate',
    mutation: true,
    status: 200,
  }),
  awaitPublication: route<AwaitPublicationBody, PlacementView>({
    method: 'POST',
    path: `${P}/placements/:id/publication`,
    action: 'budget.operate',
    mutation: true,
    status: 200,
  }),
  placementPublished: route<PlacementPublishedBody, PlacementView>({
    method: 'POST',
    path: `${P}/placements/:id/published`,
    action: 'budget.operate',
    mutation: true,
    status: 200,
  }),
  verifyPlacement: route<PlacementVerifyBody, PlacementView>({
    method: 'POST',
    path: `${P}/placements/:id/verify`,
    action: 'budget.operate',
    mutation: true,
    status: 200,
  }),
  disputePlacement: route<DisputeBody, PlacementView>({
    method: 'POST',
    path: `${P}/placements/:id/dispute`,
    action: 'placement.claim',
    mutation: true,
    status: 200,
  }),
  resolveDispute: route<ResolveDisputeBody, PlacementView>({
    method: 'POST',
    path: `${P}/placements/:id/dispute/resolve`,
    action: 'placement.claim',
    mutation: true,
    status: 200,
  }),
  cancelPlacement: route<CancelPlacementBody, PlacementView>({
    method: 'POST',
    path: `${P}/placements/:id/cancel`,
    action: 'budget.operate',
    mutation: true,
    status: 200,
  }),
  rejectPlacement: route<RejectPlacementBody, PlacementView>({
    method: 'POST',
    path: `${P}/placements/:id/reject`,
    action: 'placement.propose',
    mutation: true,
    status: 200,
  }),
  // Расходы
  listExpenses: route<void, ListPage<ExpenseView>>({
    method: 'GET',
    path: `${P}/expenses`,
    action: 'product.read',
    mutation: false,
    status: 200,
  }),
  getExpense: route<void, ExpenseView>({
    method: 'GET',
    path: `${P}/expenses/:id`,
    action: 'product.read',
    mutation: false,
    status: 200,
  }),
  createExpense: route<CreateExpenseBody, ExpenseView>({
    method: 'POST',
    path: `${P}/expenses`,
    action: 'budget.operate',
    mutation: true,
    status: 201,
  }),
  createEntry: route<CreateEntryBody, ExpenseView>({
    method: 'POST',
    path: `${P}/expenses/:id/entries`,
    action: 'budget.operate',
    mutation: true,
    status: 201,
  }),
  reconcileEntry: route<ReconcileEntryBody, ExpenseView>({
    method: 'POST',
    path: `${P}/expenses/:id/entries/:eid/reconcile`,
    action: 'budget.operate',
    mutation: true,
    status: 200,
  }),
  // Бюджет
  budget: route<void, BudgetView>({
    method: 'GET',
    path: `${P}/budget`,
    action: 'product.read',
    mutation: false,
    status: 200,
  }),
  reserveRelease: route<ReserveReleaseBody, BudgetView>({
    method: 'POST',
    path: `${P}/budget/reserve-release`,
    action: 'budget.reserve_release',
    mutation: true,
    status: 200,
  }),
  rebuildCounters: route<RebuildCountersBody, BudgetView>({
    method: 'POST',
    path: `${P}/budget/rebuild-counters`,
    action: 'budget.reserve_release',
    mutation: true,
    status: 200,
  }),
} as const;
