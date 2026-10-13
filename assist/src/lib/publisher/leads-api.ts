/**
 * AI Publisher (P-G2): клиент маршрутов P-D — очередь заявок, карточка,
 * раскрытие контакта и заметок, квалификация, проспекты, оплаты клиентов,
 * уведомления, отметка очереди, ретенция, паспорт трафика F11 (контракт
 * `sites-backend/src/modules/publisher/contracts/leads-api.ts`).
 *
 * Контакты и заметки приходят ТОЛЬКО из `revealContact`/`revealNotes`
 * (`GET`, аудит на сервере). Клиент их не кэширует: результат живёт в
 * состоянии экрана, пока открыт показ (`useRevealed`).
 */
import type { PublisherHttp } from './common-api';
import {
  arr,
  bad,
  bool,
  choice,
  computable,
  int,
  intN,
  minor,
  numRecord,
  obj,
  page,
  productPath,
  seg,
  verbs,
  str,
  strList,
  strN,
  type Computable,
} from './ops-decode';

// ── Перечни (зеркало contracts/states.ts и leads-api.ts) ─────────────────

export const LEAD_STATUSES = [
  'new',
  'contacted',
  'qualified',
  'rejected',
  'proposal_sent',
  'won',
  'lost',
] as const;
export const LEAD_TEST_FILTERS = ['include', 'exclude', 'only'] as const;
export const LEAD_TEST_REASONS = [
  'test_mode',
  'test_product',
  'team',
  'manual',
] as const;
export const CONTACT_METHODS = ['email', 'phone', 'telegram', 'other'] as const;
export const LEAD_REASON_CODES = [
  'spam',
  'vendor_offer',
  'team',
  'fake',
  'out_of_scope',
  'unreachable',
  'price',
  'timing',
  'other',
] as const;
export const CONTACT_PURPOSES = [
  'first_contact',
  'follow_up',
  'qualification',
  'payment',
  'retention',
  'other',
] as const;
export const CHANNEL_GROUPS = [
  'organic_search',
  'unpaid_social_community',
  'paid_placement',
  'other_referral',
  'direct_unknown',
] as const;
export const PRIOR_EXTERNAL_PAYMENT = ['yes', 'no', 'unknown'] as const;
export const PAYMENT_RECORD_TYPES = [
  'payment_received',
  'refund',
  'contract_signed',
] as const;
export const PAYER_KINDS = ['external', 'internal', 'test', 'self'] as const;
export const CLIENT_PAYMENT_STATUSES = [
  'pending',
  'confirmed',
  'refunded',
  'cancelled',
] as const;
export const NEW_CUSTOMER_VALUES = ['yes', 'no', 'unknown'] as const;
export const NOTIFICATION_KINDS = [
  'new_lead',
  'retention_review',
  'contact_overdue',
] as const;
export const NOTIFICATION_STATUSES = [
  'pending',
  'sending',
  'sent',
  'failed',
  'dead',
  'suppressed',
] as const;
export const OUTBOX_STATUSES = [
  'pending',
  'processing',
  'done',
  'failed',
] as const;
export const EVENT_NAMES = [
  'content_view',
  'cta_click',
  'lead_submit_success',
] as const;

export type LeadStatus = (typeof LEAD_STATUSES)[number];
export type LeadTestFilter = (typeof LEAD_TEST_FILTERS)[number];
export type ContactMethod = (typeof CONTACT_METHODS)[number];
export type LeadReasonCode = (typeof LEAD_REASON_CODES)[number];
export type ContactPurpose = (typeof CONTACT_PURPOSES)[number];
export type ChannelGroup = (typeof CHANNEL_GROUPS)[number];
export type PriorExternalPayment = (typeof PRIOR_EXTERNAL_PAYMENT)[number];
export type PaymentRecordType = (typeof PAYMENT_RECORD_TYPES)[number];
export type PayerKind = (typeof PAYER_KINDS)[number];
export type ClientPaymentStatus = (typeof CLIENT_PAYMENT_STATUSES)[number];

/**
 * Переходы машины 7.4 (кнопки карточки). Сервер решает сам — список лишь
 * не показывает заведомо невозможные шаги.
 */
export const LEAD_TRANSITIONS: Record<LeadStatus, readonly LeadStatus[]> = {
  new: ['contacted', 'qualified', 'rejected'],
  contacted: ['qualified', 'rejected'],
  qualified: ['proposal_sent', 'contacted'],
  rejected: ['contacted'],
  proposal_sent: ['won', 'lost'],
  won: [],
  lost: ['contacted'],
};

// ── Виды ─────────────────────────────────────────────────────────────────

export interface AttributionPoint {
  group: ChannelGroup;
  source: string | null;
  placementId: string | null;
  at: string;
}
export interface LeadAttributionView {
  model: 'last_non_direct_30d';
  last: AttributionPoint | null;
  first: AttributionPoint | null;
  coverage: 'linked' | 'unknown';
}
export interface LeadListItem {
  id: string;
  publicRef: string;
  status: LeadStatus;
  receivedAt: string;
  contactMethod: ContactMethod;
  budgetRange: string | null;
  selfReportedChannel: string | null;
  testFlag: boolean;
  testReason: string | null;
  suspectedSpam: boolean;
  responsibleMemberId: string | null;
  responsibleDisplayName: string | null;
  prospectId: string | null;
  prospectCode: string | null;
  duplicateOfLeadId: string | null;
  campaignId: string | null;
  contentId: string | null;
  placementId: string | null;
  contactDueAt: string | null;
  overdue: boolean;
  reviewDueAt: string;
  closedAt: string | null;
  erased: boolean;
  enriched: boolean;
  revision: number;
}
export interface LeadDecisionView {
  id: string;
  fromStatus: LeadStatus;
  toStatus: LeadStatus;
  reasonCode: string | null;
  hasNote: boolean;
  confirmedInterestAt: string | null;
  decidedBy: string;
  decidedAt: string;
  supersedesId: string | null;
}
export interface ProspectLinkView {
  prospectId: string;
  prospectCode: string;
  validFrom: string;
  reason: string;
  decidedBy: string;
}
export interface LeadCardView extends LeadListItem {
  consentState: string;
  sessionRef: string | null;
  contentSlugRaw: string | null;
  placementCodeRaw: string | null;
  attribution: LeadAttributionView | null;
  enrichedAt: string | null;
  retentionBasis: string | null;
  erasedAt: string | null;
  decisions: LeadDecisionView[];
  prospectLinks: ProspectLinkView[];
  possibleDuplicates: string[];
  outbox: {
    status: string;
    attempts: number;
    lastErrorCode: string | null;
  } | null;
  notifications: Array<{
    id: string;
    kind: string;
    status: string;
    recipientMemberId: string;
  }>;
}
/** Расшифрованный контакт — только на время показа (не кэшировать). */
export interface LeadContactView {
  leadId: string;
  publicRef: string;
  name: string;
  contactMethod: ContactMethod;
  contact: string;
  business: string | null;
  task: string;
  selfReported: string | null;
  /**
   * Версия уведомления о данных, которую видел заявитель, и версия продукта
   * при приёме (P-D S3-4); `null` — заявка до поправки (сверки нет).
   */
  dataNotice: {
    version: string;
    expected: string | null;
    matches: boolean;
  } | null;
}
export interface LeadNotesView {
  leadId: string;
  decisions: Array<{
    decisionId: string;
    toStatus: LeadStatus;
    decidedAt: string;
    note: string;
  }>;
  prospect: { prospectId: string; note: string } | null;
}
export interface ProspectView {
  id: string;
  code: string;
  isExternal: boolean;
  isTeamOrPartner: boolean;
  priorExternalPayment: PriorExternalPayment;
  mergedIntoId: string | null;
  hasNote: boolean;
  leadIds: string[];
  createdAt: string;
  revision: number;
}
export interface PaymentView {
  id: string;
  prospectId: string;
  leadId: string | null;
  recordType: PaymentRecordType;
  payerKind: PayerKind;
  amountMinor: string;
  currency: string;
  occurredAt: string;
  paymentRef: string;
  confirmation: string | null;
  status: ClientPaymentStatus;
  confirmedBy: string | null;
  confirmedAt: string | null;
  isNewCustomer: 'yes' | 'no' | 'unknown';
  revenue: boolean;
  createdAt: string;
}
export interface PaymentsPage {
  items: PaymentView[];
  nextBefore: string | null;
  summary: {
    revenueByCurrency: Record<string, string>;
    nonRevenueCount: Record<string, number>;
    commercialValidation: boolean;
  };
}
export interface NotificationView {
  id: string;
  leadId: string;
  leadRef: string;
  kind: (typeof NOTIFICATION_KINDS)[number];
  recipientMemberId: string;
  status: (typeof NOTIFICATION_STATUSES)[number];
  attempts: number;
  nextAttemptAt: string;
  lastErrorCode: string | null;
  sentAt: string | null;
  createdAt: string;
}
export interface OutboxView {
  id: string;
  leadId: string;
  leadRef: string;
  status: (typeof OUTBOX_STATUSES)[number];
  attempts: number;
  lastErrorCode: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface QueueCheckView {
  id: string;
  checkedBy: string;
  checkedAt: string;
  workDate: string;
  openCount: number;
  overdueCount: number;
}
export interface QueueChecksPage {
  items: QueueCheckView[];
  missingWorkDates: string[];
}
export interface RetentionDueItem {
  leadId: string;
  publicRef: string;
  status: LeadStatus;
  reviewDueAt: string;
  closedAt: string | null;
  retentionBasis: string | null;
  responsibleMemberId: string | null;
  overdue: boolean;
}
export interface TrafficPassport {
  filter: {
    contentId: string | null;
    placementId: string | null;
    from: string | null;
    to: string | null;
  };
  publications: Array<{
    id: string;
    finalUrl: string;
    stage: string;
    status: string;
    publishedAt: string | null;
  }>;
  placement: {
    id: string;
    placementCode: string;
    status: string;
    publishedAt: string | null;
  } | null;
  /** null — сессии не измеряются (`analytics_storage='none'`), не ноль. */
  sessions: number | null;
  sessionMode: 'session_ref' | 'none';
  events: Record<(typeof EVENT_NAMES)[number], number>;
  byChannel: Partial<Record<ChannelGroup, number>>;
  leads: {
    total: number;
    test: number;
    pendingEnrichment: number;
    /** Срабатывания ловушки формы за последний час (обезличенно, P-D S3-5). */
    trapHitsLastHour: number | null;
  };
  qualified: { allExternal: number; linked: number; unknown: number };
  coverage: Computable<number>;
  directCpl: Computable<string>;
  productCpl: Computable<string>;
  currency: string | null;
}
export interface TrafficEventView {
  id: string;
  eventId: string;
  name: string;
  occurredAt: string;
  contentSlugRaw: string | null;
  placementCodeRaw: string | null;
  referrerHost: string | null;
  sessionRef: string | null;
  utm: Record<string, string> | null;
  utmRedacted: boolean;
  contentId: string | null;
  placementId: string | null;
  channelGroup: string | null;
  leadId: string | null;
  testFlag: boolean;
  enrichedAt: string | null;
}

// ── Декодеры ─────────────────────────────────────────────────────────────

/** Ключи ПД, которых НЕ должно быть в списках и карточке (§11.1). */
export const PII_KEYS = ['contact', 'name', 'task', 'business', 'noteEnc'];

function noPii(o: Record<string, unknown>, what: string) {
  for (const k of PII_KEYS) {
    // Ответ с контактом там, где его быть не должно, не показываем вовсе.
    if (k in o) bad(`${what}: pii key ${k}`);
  }
}

export function decodeLeadItem(v: unknown): LeadListItem {
  const o = obj(v, 'lead');
  noPii(o, 'lead');
  return {
    id: str(o.id),
    publicRef: str(o.publicRef),
    status: choice(o.status, LEAD_STATUSES, 'lead.status'),
    receivedAt: str(o.receivedAt),
    contactMethod: choice(o.contactMethod, CONTACT_METHODS, 'contactMethod'),
    budgetRange: strN(o.budgetRange),
    selfReportedChannel: strN(o.selfReportedChannel),
    testFlag: bool(o.testFlag),
    testReason: strN(o.testReason),
    suspectedSpam: bool(o.suspectedSpam),
    responsibleMemberId: strN(o.responsibleMemberId),
    responsibleDisplayName: strN(o.responsibleDisplayName),
    prospectId: strN(o.prospectId),
    prospectCode: strN(o.prospectCode),
    duplicateOfLeadId: strN(o.duplicateOfLeadId),
    campaignId: strN(o.campaignId),
    contentId: strN(o.contentId),
    placementId: strN(o.placementId),
    contactDueAt: strN(o.contactDueAt),
    overdue: bool(o.overdue),
    reviewDueAt: str(o.reviewDueAt),
    closedAt: strN(o.closedAt),
    erased: bool(o.erased),
    enriched: bool(o.enriched),
    revision: int(o.revision),
  };
}

function attrPoint(v: unknown): AttributionPoint | null {
  if (v === null || v === undefined) return null;
  const o = obj(v, 'attribution.point');
  return {
    group: choice(o.group, CHANNEL_GROUPS, 'attribution.group'),
    source: strN(o.source),
    placementId: strN(o.placementId),
    at: str(o.at),
  };
}

export function decodeLeadCard(v: unknown): LeadCardView {
  const o = obj(v, 'leadCard');
  const base = decodeLeadItem(o);
  const a =
    o.attribution === null || o.attribution === undefined
      ? null
      : obj(o.attribution, 'attribution');
  const ob =
    o.outbox === null || o.outbox === undefined
      ? null
      : obj(o.outbox, 'outbox');
  return {
    ...base,
    consentState: str(o.consentState),
    sessionRef: strN(o.sessionRef),
    contentSlugRaw: strN(o.contentSlugRaw),
    placementCodeRaw: strN(o.placementCodeRaw),
    attribution: a
      ? {
          model: choice(a.model, ['last_non_direct_30d'] as const, 'model'),
          last: attrPoint(a.last),
          first: attrPoint(a.first),
          coverage: choice(a.coverage, ['linked', 'unknown'] as const),
        }
      : null,
    enrichedAt: strN(o.enrichedAt),
    retentionBasis: strN(o.retentionBasis),
    erasedAt: strN(o.erasedAt),
    decisions: arr(o.decisions, 'decisions').map((x) => {
      const d = obj(x, 'decision');
      return {
        id: str(d.id),
        fromStatus: choice(d.fromStatus, LEAD_STATUSES, 'fromStatus'),
        toStatus: choice(d.toStatus, LEAD_STATUSES, 'toStatus'),
        reasonCode: strN(d.reasonCode),
        hasNote: bool(d.hasNote),
        confirmedInterestAt: strN(d.confirmedInterestAt),
        decidedBy: str(d.decidedBy),
        decidedAt: str(d.decidedAt),
        supersedesId: strN(d.supersedesId),
      };
    }),
    prospectLinks: arr(o.prospectLinks, 'prospectLinks').map((x) => {
      const l = obj(x, 'prospectLink');
      return {
        prospectId: str(l.prospectId),
        prospectCode: str(l.prospectCode),
        validFrom: str(l.validFrom),
        reason: str(l.reason),
        decidedBy: str(l.decidedBy),
      };
    }),
    possibleDuplicates: strList(o.possibleDuplicates),
    outbox: ob
      ? {
          status: str(ob.status),
          attempts: int(ob.attempts),
          lastErrorCode: strN(ob.lastErrorCode),
        }
      : null,
    notifications: arr(o.notifications, 'notifications').map((x) => {
      const n = obj(x, 'notification');
      return {
        id: str(n.id),
        kind: str(n.kind),
        status: str(n.status),
        recipientMemberId: str(n.recipientMemberId),
      };
    }),
  };
}

export function decodeContact(v: unknown): LeadContactView {
  const o = obj(v, 'contact');
  return {
    leadId: str(o.leadId),
    publicRef: str(o.publicRef),
    name: str(o.name),
    contactMethod: choice(o.contactMethod, CONTACT_METHODS, 'contactMethod'),
    contact: str(o.contact),
    business: strN(o.business),
    task: str(o.task),
    selfReported: strN(o.selfReported),
    dataNotice: (() => {
      if (o.dataNotice === null || o.dataNotice === undefined) return null;
      const d = obj(o.dataNotice, 'contact.dataNotice');
      return {
        version: str(d.version),
        expected: strN(d.expected),
        matches: bool(d.matches),
      };
    })(),
  };
}

export function decodeNotes(v: unknown): LeadNotesView {
  const o = obj(v, 'notes');
  const p =
    o.prospect === null || o.prospect === undefined
      ? null
      : obj(o.prospect, 'notes.prospect');
  return {
    leadId: str(o.leadId),
    decisions: arr(o.decisions, 'notes.decisions').map((x) => {
      const d = obj(x, 'notes.decision');
      return {
        decisionId: str(d.decisionId),
        toStatus: choice(d.toStatus, LEAD_STATUSES, 'notes.toStatus'),
        decidedAt: str(d.decidedAt),
        note: str(d.note),
      };
    }),
    prospect: p ? { prospectId: str(p.prospectId), note: str(p.note) } : null,
  };
}

export function decodeProspect(v: unknown): ProspectView {
  const o = obj(v, 'prospect');
  return {
    id: str(o.id),
    code: str(o.code),
    isExternal: bool(o.isExternal),
    isTeamOrPartner: bool(o.isTeamOrPartner),
    priorExternalPayment: choice(
      o.priorExternalPayment,
      PRIOR_EXTERNAL_PAYMENT,
      'priorExternalPayment'
    ),
    mergedIntoId: strN(o.mergedIntoId),
    hasNote: bool(o.hasNote),
    leadIds: strList(o.leadIds),
    createdAt: str(o.createdAt),
    revision: int(o.revision),
  };
}

export function decodePayment(v: unknown): PaymentView {
  const o = obj(v, 'payment');
  return {
    id: str(o.id),
    prospectId: str(o.prospectId),
    leadId: strN(o.leadId),
    recordType: choice(o.recordType, PAYMENT_RECORD_TYPES, 'recordType'),
    payerKind: choice(o.payerKind, PAYER_KINDS, 'payerKind'),
    amountMinor: minor(o.amountMinor),
    currency: str(o.currency),
    occurredAt: str(o.occurredAt),
    paymentRef: str(o.paymentRef),
    confirmation: strN(o.confirmation),
    status: choice(o.status, CLIENT_PAYMENT_STATUSES, 'payment.status'),
    confirmedBy: strN(o.confirmedBy),
    confirmedAt: strN(o.confirmedAt),
    isNewCustomer: choice(
      o.isNewCustomer,
      NEW_CUSTOMER_VALUES,
      'isNewCustomer'
    ),
    revenue: bool(o.revenue),
    createdAt: str(o.createdAt),
  };
}

export function decodePaymentsPage(v: unknown): PaymentsPage {
  const o = obj(v, 'payments');
  const p = page(o, decodePayment);
  const s = obj(o.summary, 'payments.summary');
  const rev: Record<string, string> = {};
  for (const [k, x] of Object.entries(obj(s.revenueByCurrency, 'revenue'))) {
    rev[k] = minor(x);
  }
  return {
    ...p,
    summary: {
      revenueByCurrency: rev,
      nonRevenueCount: numRecord(s.nonRevenueCount, 'nonRevenueCount'),
      commercialValidation: bool(s.commercialValidation),
    },
  };
}

export function decodeNotification(v: unknown): NotificationView {
  const o = obj(v, 'notification');
  return {
    id: str(o.id),
    leadId: str(o.leadId),
    leadRef: str(o.leadRef),
    kind: choice(o.kind, NOTIFICATION_KINDS, 'notification.kind'),
    recipientMemberId: str(o.recipientMemberId),
    status: choice(o.status, NOTIFICATION_STATUSES, 'notification.status'),
    attempts: int(o.attempts),
    nextAttemptAt: str(o.nextAttemptAt),
    lastErrorCode: strN(o.lastErrorCode),
    sentAt: strN(o.sentAt),
    createdAt: str(o.createdAt),
  };
}

export function decodeOutbox(v: unknown): OutboxView {
  const o = obj(v, 'outbox');
  return {
    id: str(o.id),
    leadId: str(o.leadId),
    leadRef: str(o.leadRef),
    status: choice(o.status, OUTBOX_STATUSES, 'outbox.status'),
    attempts: int(o.attempts),
    lastErrorCode: strN(o.lastErrorCode),
    createdAt: str(o.createdAt),
    updatedAt: str(o.updatedAt),
  };
}

export function decodeQueueCheck(v: unknown): QueueCheckView {
  const o = obj(v, 'queueCheck');
  return {
    id: str(o.id),
    checkedBy: str(o.checkedBy),
    checkedAt: str(o.checkedAt),
    workDate: str(o.workDate),
    openCount: int(o.openCount),
    overdueCount: int(o.overdueCount),
  };
}

export function decodeRetentionItem(v: unknown): RetentionDueItem {
  const o = obj(v, 'retention');
  return {
    leadId: str(o.leadId),
    publicRef: str(o.publicRef),
    status: choice(o.status, LEAD_STATUSES, 'retention.status'),
    reviewDueAt: str(o.reviewDueAt),
    closedAt: strN(o.closedAt),
    retentionBasis: strN(o.retentionBasis),
    responsibleMemberId: strN(o.responsibleMemberId),
    overdue: bool(o.overdue),
  };
}

export function decodePassport(v: unknown): TrafficPassport {
  const o = obj(v, 'passport');
  const f = obj(o.filter, 'passport.filter');
  const ev = obj(o.events, 'passport.events');
  const bc = obj(o.byChannel ?? {}, 'passport.byChannel');
  const byChannel: TrafficPassport['byChannel'] = {};
  for (const [k, x] of Object.entries(bc)) {
    byChannel[choice(k, CHANNEL_GROUPS, 'byChannel.key')] = int(x);
  }
  const l = obj(o.leads, 'passport.leads');
  const q = obj(o.qualified, 'passport.qualified');
  const pl =
    o.placement === null || o.placement === undefined
      ? null
      : obj(o.placement, 'passport.placement');
  return {
    filter: {
      contentId: strN(f.contentId),
      placementId: strN(f.placementId),
      from: strN(f.from),
      to: strN(f.to),
    },
    publications: arr(o.publications, 'passport.publications').map((x) => {
      const p = obj(x, 'passport.publication');
      return {
        id: str(p.id),
        finalUrl: str(p.finalUrl),
        stage: str(p.stage),
        status: str(p.status),
        publishedAt: strN(p.publishedAt),
      };
    }),
    placement: pl
      ? {
          id: str(pl.id),
          placementCode: str(pl.placementCode),
          status: str(pl.status),
          publishedAt: strN(pl.publishedAt),
        }
      : null,
    sessions: intN(o.sessions),
    sessionMode: choice(o.sessionMode, ['session_ref', 'none'] as const),
    events: {
      content_view: int(ev.content_view),
      cta_click: int(ev.cta_click),
      lead_submit_success: int(ev.lead_submit_success),
    },
    byChannel,
    leads: {
      total: int(l.total),
      test: int(l.test),
      pendingEnrichment: int(l.pendingEnrichment),
      trapHitsLastHour: intN(l.trapHitsLastHour),
    },
    qualified: {
      allExternal: int(q.allExternal),
      linked: int(q.linked),
      unknown: int(q.unknown),
    },
    coverage: computable(o.coverage, (x) => int(x) as number, 'coverage'),
    directCpl: computable(o.directCpl, (x) => minor(x), 'directCpl'),
    productCpl: computable(o.productCpl, (x) => minor(x), 'productCpl'),
    currency: strN(o.currency),
  };
}

export function decodeTrafficEvent(v: unknown): TrafficEventView {
  const o = obj(v, 'event');
  let utm: Record<string, string> | null = null;
  if (o.utm !== null && o.utm !== undefined) {
    utm = {};
    for (const [k, x] of Object.entries(obj(o.utm, 'event.utm'))) {
      utm[k] = str(x);
    }
  }
  return {
    id: str(o.id),
    eventId: str(o.eventId),
    name: str(o.name),
    occurredAt: str(o.occurredAt),
    contentSlugRaw: strN(o.contentSlugRaw),
    placementCodeRaw: strN(o.placementCodeRaw),
    referrerHost: strN(o.referrerHost),
    sessionRef: strN(o.sessionRef),
    utm,
    utmRedacted: bool(o.utmRedacted),
    contentId: strN(o.contentId),
    placementId: strN(o.placementId),
    channelGroup: strN(o.channelGroup),
    leadId: strN(o.leadId),
    testFlag: bool(o.testFlag),
    enrichedAt: strN(o.enrichedAt),
  };
}

// ── Клиент ───────────────────────────────────────────────────────────────

export interface LeadListFilter {
  status?: LeadStatus;
  /** id участника или `none` (без ответственного). */
  responsible?: string;
  test?: LeadTestFilter;
  before?: string;
  limit?: number;
}

export function createLeadsApi(http: PublisherHttp) {
  const P = productPath;
  const { get, post, patch } = verbs(http);
  const leadPost = async (
    pid: string,
    id: string,
    step: string,
    opKey: string,
    body: Record<string, unknown>
  ) =>
    decodeLeadCard(
      await post(`${P(pid)}/leads/${seg(id)}/${step}`, { ...body }, opKey)
    );
  return {
    leads: async (pid: string, f: LeadListFilter = {}) =>
      page(await get(`${P(pid)}/leads`, { ...f }), decodeLeadItem),
    lead: async (pid: string, id: string) =>
      decodeLeadCard(await get(`${P(pid)}/leads/${seg(id)}`)),
    /**
     * Раскрытие контакта: `POST` без `opKey` (Р-PUB-Z2-25), цель
     * обязательна, ответ не кэшируется и не хранится.
     */
    revealContact: async (pid: string, id: string, purpose: ContactPurpose) =>
      decodeContact(
        await http.reveal(`${P(pid)}/leads/${seg(id)}/contact`, { purpose })
      ),
    revealNotes: async (pid: string, id: string) =>
      decodeNotes(await http.reveal(`${P(pid)}/leads/${seg(id)}/notes`, {})),
    transition: (
      pid: string,
      id: string,
      opKey: string,
      body: {
        expectedRevision: number;
        to: LeadStatus;
        reasonCode?: string;
        note?: string;
        confirmedInterestAt?: string;
      }
    ) => leadPost(pid, id, 'transition', opKey, body),
    assign: (
      pid: string,
      id: string,
      opKey: string,
      body: { expectedRevision: number; responsibleMemberId: string | null }
    ) => leadPost(pid, id, 'assign', opKey, body),
    testFlag: (
      pid: string,
      id: string,
      opKey: string,
      body: {
        expectedRevision: number;
        testFlag: boolean;
        testReason?: 'team' | 'manual';
        reason: string;
      }
    ) => leadPost(pid, id, 'test-flag', opKey, body),
    duplicate: (
      pid: string,
      id: string,
      opKey: string,
      body: {
        expectedRevision: number;
        duplicateOfLeadId: string | null;
        reason: string;
      }
    ) => leadPost(pid, id, 'duplicate', opKey, body),
    setProspect: (
      pid: string,
      id: string,
      opKey: string,
      body: { expectedRevision: number; prospectId: string; reason: string }
    ) => leadPost(pid, id, 'prospect', opKey, body),
    erase: (
      pid: string,
      id: string,
      opKey: string,
      body: { expectedRevision: number; basis: string }
    ) => leadPost(pid, id, 'erase', opKey, body),
    retain: (
      pid: string,
      id: string,
      opKey: string,
      body: { expectedRevision: number; basis: string; nextReviewAt: string }
    ) => leadPost(pid, id, 'retention', opKey, body),

    prospects: async (pid: string, before?: string) =>
      page(await get(`${P(pid)}/prospects`, { before }), decodeProspect),
    createProspect: async (
      pid: string,
      opKey: string,
      body: {
        isExternal?: boolean;
        isTeamOrPartner?: boolean;
        priorExternalPayment?: PriorExternalPayment;
        note?: string;
      }
    ) => decodeProspect(await post(`${P(pid)}/prospects`, { ...body }, opKey)),
    updateProspect: async (
      pid: string,
      id: string,
      opKey: string,
      body: {
        expectedRevision: number;
        isExternal?: boolean;
        isTeamOrPartner?: boolean;
        priorExternalPayment?: PriorExternalPayment;
        note?: string | null;
      }
    ) =>
      decodeProspect(
        await patch(`${P(pid)}/prospects/${seg(id)}`, { ...body }, opKey)
      ),
    mergeProspects: async (
      pid: string,
      opKey: string,
      body: { fromId: string; intoId: string; reason: string }
    ) =>
      decodeProspect(
        await post(`${P(pid)}/prospects/merge`, { ...body }, opKey)
      ),

    payments: async (
      pid: string,
      f: { prospectId?: string; before?: string } = {}
    ) => decodePaymentsPage(await get(`${P(pid)}/payments`, f)),
    createPayment: async (
      pid: string,
      opKey: string,
      body: {
        prospectId: string;
        leadId?: string | null;
        recordType: PaymentRecordType;
        payerKind: PayerKind;
        amountMinor: string;
        currency: string;
        occurredAt: string;
        paymentRef: string;
        confirmation?: string | null;
      }
    ) => decodePayment(await post(`${P(pid)}/payments`, { ...body }, opKey)),
    paymentStep: async (
      pid: string,
      id: string,
      step: 'confirm' | 'refund' | 'cancel',
      opKey: string,
      body: { confirmation?: string | null } = {}
    ) =>
      decodePayment(
        await post(`${P(pid)}/payments/${seg(id)}/${step}`, { ...body }, opKey)
      ),

    notifications: async (pid: string, status?: string, before?: string) =>
      page(
        await get(`${P(pid)}/notifications`, { status, before }),
        decodeNotification
      ),
    retryNotification: async (pid: string, id: string, opKey: string) =>
      decodeNotification(
        await post(`${P(pid)}/notifications/${seg(id)}/retry`, {}, opKey)
      ),
    outbox: async (pid: string, status?: string, before?: string) =>
      page(
        await get(`${P(pid)}/lead-outbox`, { status, before }),
        decodeOutbox
      ),
    queueChecks: async (pid: string, from?: string, to?: string) => {
      const o = obj(await get(`${P(pid)}/queue-checks`, { from, to }));
      return {
        items: arr(o.items, 'queueChecks').map(decodeQueueCheck),
        missingWorkDates: strList(o.missingWorkDates),
      } satisfies QueueChecksPage;
    },
    markQueueChecked: async (pid: string, opKey: string) =>
      decodeQueueCheck(await post(`${P(pid)}/queue-checks`, {}, opKey)),
    retentionDue: async (pid: string, withinDays?: number) =>
      arr(
        obj(await get(`${P(pid)}/retention/due`, { withinDays })).items,
        'retention'
      ).map(decodeRetentionItem),
    passport: async (
      pid: string,
      f: {
        contentId?: string;
        placementId?: string;
        from?: string;
        to?: string;
      } = {}
    ) => decodePassport(await get(`${P(pid)}/traffic/passport`, f)),
    events: async (
      pid: string,
      f: { test?: LeadTestFilter; name?: string; before?: string } = {}
    ) => page(await get(`${P(pid)}/traffic/events`, f), decodeTrafficEvent),
  };
}

export type LeadsApi = ReturnType<typeof createLeadsApi>;
