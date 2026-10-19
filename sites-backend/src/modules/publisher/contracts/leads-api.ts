/**
 * AI Publisher — контракт маршрутов кабинета P-D (проектный документ §11.3
 * «P-D — заявки, продажи, паспорт трафика»; §6.5, §7.4, §15.2–15.3),
 * заполненный по `_template.ts`. Тест `leads-api.spec.ts` сверяет список с
 * контроллерами пакета (`leads/*.controller.ts`).
 *
 * Правила (§11.1, §1 п.7): ответы мутаций и списков НЕ несут контактов,
 * имени, текста задачи и шифрованных заметок; раскрытие — отдельные
 * `POST …/contact` и `POST …/notes` (с аудитом, без хранения ответа; после
 * предаудита D1-02 прежний `GET` — 405). Свободный
 * текст заметок уходит только в шифр (`noteEnc`), ответ его не возвращает.
 * Суммы — строки цифр (`MinorJson`), даты — ISO.
 *
 * Чистый модуль: только типы и константы.
 */
import { route } from './_template';
import type {
  Computable,
  ListPage,
  MinorJson,
  MutationBody,
  RevisionedBody,
} from './common';
import type { ChannelGroup, ContactMethod, LeadStatus } from './states';

// ── Заявки ───────────────────────────────────────────────────────────────

/** `pub_leads.attribution` (§6.5) — та же форма, что `core/attribution.ts`. */
export interface LeadAttributionView {
  model: 'last_non_direct_30d';
  last: {
    group: ChannelGroup;
    source: string | null;
    placementId: string | null;
    at: string;
  } | null;
  first: {
    group: ChannelGroup;
    source: string | null;
    placementId: string | null;
    at: string;
  } | null;
  coverage: 'linked' | 'unknown';
}

export const LEAD_TEST_FILTERS = ['include', 'exclude', 'only'] as const;
export type LeadTestFilter = (typeof LEAD_TEST_FILTERS)[number];

/** Строка очереди и CSV (без контактов). */
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
  /** Срок первого контакта (`contact_sla`); null — ещё не обогащена. */
  contactDueAt: string | null;
  /** `new` и срок первого контакта прошёл (§6.5, ТЗ §6). */
  overdue: boolean;
  reviewDueAt: string;
  closedAt: string | null;
  /** Контакт удалён по ретенции. */
  erased: boolean;
  /** Обогащение прошло (`enrichedAt`); иначе атрибуция и проспект — «ещё нет». */
  enriched: boolean;
  revision: number;
}

export interface LeadDecisionView {
  id: string;
  fromStatus: LeadStatus;
  toStatus: LeadStatus;
  reasonCode: string | null;
  /** Есть шифрованная заметка (текст — только `POST …/notes`). */
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

/** Карточка заявки: история, атрибуция, возможные дубли (только id). */
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
  /** Другие заявки с тем же нормализованным контактом (`matchHash`). */
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

export interface LeadListQuery {
  status?: LeadStatus;
  responsible?: string;
  test?: LeadTestFilter;
  before?: string;
  limit?: number;
  format?: 'csv';
}

/** Расшифрованный контакт (только `POST …/contact`, `no-store`, аудит). */
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
   * Уведомление о данных при отправке (аудит P-D S3-4): версия формы,
   * версия продукта на момент приёма и совпадение (мягкая пометка;
   * `null` — заявка принята до появления следа).
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

/** Цели раскрытия контакта (`?purpose=`, в журнал аудита). */
export const CONTACT_PURPOSES = [
  'first_contact',
  'follow_up',
  'qualification',
  'payment',
  'retention',
  'other',
] as const;
export type ContactPurpose = (typeof CONTACT_PURPOSES)[number];

export interface LeadTransitionBody extends RevisionedBody {
  to: LeadStatus;
  reasonCode?: string;
  /** Свободный текст — только в шифр (`noteEnc`); ≤ 2000. */
  note?: string;
  /** Обязателен для `qualified` (ISO, не в будущем). */
  confirmedInterestAt?: string;
}
export interface LeadAssignBody extends RevisionedBody {
  responsibleMemberId: string | null;
}
export interface LeadTestFlagBody extends RevisionedBody {
  testFlag: boolean;
  /** `team|manual` (при включении), умолчание `manual`. */
  testReason?: 'team' | 'manual';
  /** Основание (в журнал; похожее на контакт — 400 `pii`). */
  reason: string;
}
export interface LeadDuplicateBody extends RevisionedBody {
  duplicateOfLeadId: string | null;
  reason: string;
}
export interface LeadProspectBody extends RevisionedBody {
  /** id проспекта или `new` (разделение). */
  prospectId: string;
  reason: string;
}

// ── Проспекты ─────────────────────────────────────────────────────────────

export interface ProspectView {
  id: string;
  code: string;
  isExternal: boolean;
  isTeamOrPartner: boolean;
  priorExternalPayment: 'yes' | 'no' | 'unknown';
  mergedIntoId: string | null;
  hasNote: boolean;
  leadIds: string[];
  createdAt: string;
  revision: number;
}
export interface ProspectCreateBody extends MutationBody {
  isExternal?: boolean;
  isTeamOrPartner?: boolean;
  priorExternalPayment?: 'yes' | 'no' | 'unknown';
  /** В шифр (`noteEnc`). */
  note?: string;
}
export interface ProspectUpdateBody extends RevisionedBody {
  isExternal?: boolean;
  isTeamOrPartner?: boolean;
  priorExternalPayment?: 'yes' | 'no' | 'unknown';
  /** В шифр; `null` — стереть заметку. */
  note?: string | null;
}
export interface ProspectMergeBody extends MutationBody {
  fromId: string;
  intoId: string;
  reason: string;
}

// ── Оплаты клиентов (AT-CORE-24) ──────────────────────────────────────────

export interface PaymentView {
  id: string;
  prospectId: string;
  leadId: string | null;
  recordType: 'payment_received' | 'refund' | 'contract_signed';
  payerKind: 'external' | 'internal' | 'test' | 'self';
  amountMinor: MinorJson;
  currency: string;
  occurredAt: string;
  paymentRef: string;
  confirmation: string | null;
  status: 'pending' | 'confirmed' | 'refunded' | 'cancelled';
  confirmedBy: string | null;
  confirmedAt: string | null;
  isNewCustomer: 'yes' | 'no' | 'unknown';
  /** Считается выручкой (внешняя подтверждённая оплата). */
  revenue: boolean;
  createdAt: string;
}
export interface PaymentCreateBody extends MutationBody {
  prospectId: string;
  leadId?: string | null;
  recordType: PaymentView['recordType'];
  payerKind: PaymentView['payerKind'];
  amountMinor: MinorJson;
  currency: string;
  occurredAt: string;
  paymentRef: string;
  confirmation?: string | null;
}
export interface PaymentConfirmBody extends MutationBody {
  confirmation?: string | null;
}
export interface PaymentsPage extends ListPage<PaymentView> {
  /**
   * Выручка — только `external` + `payment_received` + `confirmed` (за
   * вычетом возвращённых — они `refunded`); прочее — отдельно, по видам.
   * Без подтверждённой внешней оплаты — `commercialValidation: false`
   * («коммерческая валидация не подтверждена», ТЗ AT-CORE-24).
   */
  summary: {
    revenueByCurrency: Record<string, MinorJson>;
    nonRevenueCount: Record<string, number>;
    commercialValidation: boolean;
  };
}

// ── Очередь, уведомления, ретенция ───────────────────────────────────────

export interface NotificationView {
  id: string;
  leadId: string;
  leadRef: string;
  kind: 'new_lead' | 'retention_review' | 'contact_overdue';
  recipientMemberId: string;
  status: 'pending' | 'sending' | 'sent' | 'failed' | 'dead' | 'suppressed';
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
  status: 'pending' | 'processing' | 'done' | 'failed';
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
  /** Рабочие дни периода (календарь `contact_sla`) без отметки. */
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
export interface EraseBody extends RevisionedBody {
  basis: string;
}
export interface RetainBody extends RevisionedBody {
  basis: string;
  /** Следующая дата пересмотра: после «сейчас» и не дальше 90 дней. */
  nextReviewAt: string;
}

// ── Паспорт трафика F11 ──────────────────────────────────────────────────

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
  /** Нетестовые сессии (при `analytics_storage='session'`; иначе `null` — не измеряются). */
  sessions: number | null;
  sessionMode: 'session_ref' | 'none';
  events: Record<'content_view' | 'cta_click' | 'lead_submit_success', number>;
  byChannel: Partial<Record<ChannelGroup, number>>;
  leads: {
    total: number;
    test: number;
    pendingEnrichment: number;
    /**
     * Срабатывания ловушки `hp` продукта за последний час (обезличенный
     * след без тела и IP, аудит P-D S3-5); заявки они не создают.
     */
    trapHitsLastHour: number;
  };
  qualified: {
    /** Уникальные внешние квалифицированные проспекты (продукт за период). */
    allExternal: number;
    /** Из них технически связанные с фильтром (основная модель). */
    linked: number;
    unknown: number;
  };
  coverage: Computable<number>;
  /**
   * Прямой CPL §9.4 — расчёт отчёта P-E (`computeReport`, снимок `ad_hoc`
   * за период паспорта): Σ подтверждённых deliver + adjust / проспекты,
   * чья первая квалифицированная заявка технически связана с размещением
   * (один проспект — одно размещение). С `placementId` — этого размещения,
   * без — всех размещений.
   */
  directCpl: Computable<MinorJson>;
  /** Продуктовый CPL §9.4 (операционная стоимость / все внешние квалифицированные) — как отчёт P-E. */
  productCpl: Computable<MinorJson>;
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

const P = '/publisher/products/:pid';

export const LEADS_ROUTES = {
  listLeads: route<LeadListQuery, ListPage<LeadListItem>>({
    method: 'GET',
    path: `${P}/leads`,
    action: 'lead.read',
    mutation: false,
    status: 200,
  }),
  getLead: route<void, LeadCardView>({
    method: 'GET',
    path: `${P}/leads/:id`,
    action: 'lead.read',
    mutation: false,
    status: 200,
  }),
  /**
   * Раскрытие — `POST` с телом `{purpose}` (Р-PUB-Z2-25, предаудит D1-02):
   * запись в журнал доступа к ПД не делается «безопасным» методом, который
   * барьеры CSRF веб-кабинета пропускают. Не мутация в смысле операций: без
   * `opKey`, ключа идемпотентности и хранения ответа (`mutation: false`).
   */
  revealContact: route<{ purpose: ContactPurpose }, LeadContactView>({
    method: 'POST',
    path: `${P}/leads/:id/contact`,
    action: 'lead.contact.reveal',
    mutation: false,
    status: 200,
  }),
  revealNotes: route<void, LeadNotesView>({
    method: 'POST',
    path: `${P}/leads/:id/notes`,
    action: 'lead.contact.reveal',
    mutation: false,
    status: 200,
  }),
  /** Прежний `GET` раскрытия — 405 `Allow: POST`, без записи в журнал. */
  revealContactGetRemoved: route<void, never>({
    method: 'GET',
    path: `${P}/leads/:id/contact`,
    action: 'lead.contact.reveal',
    mutation: false,
    status: 405,
  }),
  revealNotesGetRemoved: route<void, never>({
    method: 'GET',
    path: `${P}/leads/:id/notes`,
    action: 'lead.contact.reveal',
    mutation: false,
    status: 405,
  }),
  transition: route<LeadTransitionBody, LeadCardView>({
    method: 'POST',
    path: `${P}/leads/:id/transition`,
    action: 'lead.manage',
    mutation: true,
    status: 200,
  }),
  assign: route<LeadAssignBody, LeadCardView>({
    method: 'POST',
    path: `${P}/leads/:id/assign`,
    action: 'lead.manage',
    mutation: true,
    status: 200,
  }),
  testFlag: route<LeadTestFlagBody, LeadCardView>({
    method: 'POST',
    path: `${P}/leads/:id/test-flag`,
    action: 'lead.test_flag',
    mutation: true,
    status: 200,
  }),
  duplicate: route<LeadDuplicateBody, LeadCardView>({
    method: 'POST',
    path: `${P}/leads/:id/duplicate`,
    action: 'lead.manage',
    mutation: true,
    status: 200,
  }),
  setProspect: route<LeadProspectBody, LeadCardView>({
    method: 'POST',
    path: `${P}/leads/:id/prospect`,
    action: 'lead.manage',
    mutation: true,
    status: 200,
  }),
  listProspects: route<void, ListPage<ProspectView>>({
    method: 'GET',
    path: `${P}/prospects`,
    action: 'lead.manage',
    mutation: false,
    status: 200,
  }),
  createProspect: route<ProspectCreateBody, ProspectView>({
    method: 'POST',
    path: `${P}/prospects`,
    action: 'lead.manage',
    mutation: true,
    status: 201,
  }),
  updateProspect: route<ProspectUpdateBody, ProspectView>({
    method: 'PATCH',
    path: `${P}/prospects/:prospectId`,
    action: 'lead.manage',
    mutation: true,
    status: 200,
  }),
  mergeProspects: route<ProspectMergeBody, ProspectView>({
    method: 'POST',
    path: `${P}/prospects/merge`,
    action: 'lead.manage',
    mutation: true,
    status: 200,
  }),
  listPayments: route<void, PaymentsPage>({
    method: 'GET',
    path: `${P}/payments`,
    action: 'payment.manage',
    mutation: false,
    status: 200,
  }),
  createPayment: route<PaymentCreateBody, PaymentView>({
    method: 'POST',
    path: `${P}/payments`,
    action: 'payment.manage',
    mutation: true,
    status: 201,
  }),
  confirmPayment: route<PaymentConfirmBody, PaymentView>({
    method: 'POST',
    path: `${P}/payments/:paymentId/confirm`,
    action: 'payment.manage',
    mutation: true,
    status: 200,
  }),
  refundPayment: route<MutationBody, PaymentView>({
    method: 'POST',
    path: `${P}/payments/:paymentId/refund`,
    action: 'payment.manage',
    mutation: true,
    status: 200,
  }),
  cancelPayment: route<MutationBody, PaymentView>({
    method: 'POST',
    path: `${P}/payments/:paymentId/cancel`,
    action: 'payment.manage',
    mutation: true,
    status: 200,
  }),
  listNotifications: route<void, ListPage<NotificationView>>({
    method: 'GET',
    path: `${P}/notifications`,
    action: 'lead.manage',
    mutation: false,
    status: 200,
  }),
  retryNotification: route<MutationBody, NotificationView>({
    method: 'POST',
    path: `${P}/notifications/:notificationId/retry`,
    action: 'lead.manage',
    mutation: true,
    status: 200,
  }),
  listOutbox: route<void, ListPage<OutboxView>>({
    method: 'GET',
    path: `${P}/lead-outbox`,
    action: 'lead.manage',
    mutation: false,
    status: 200,
  }),
  createQueueCheck: route<MutationBody, QueueCheckView>({
    method: 'POST',
    path: `${P}/queue-checks`,
    action: 'queue.check',
    mutation: true,
    status: 201,
  }),
  listQueueChecks: route<void, QueueChecksPage>({
    method: 'GET',
    path: `${P}/queue-checks`,
    action: 'queue.check',
    mutation: false,
    status: 200,
  }),
  retentionDue: route<void, { items: RetentionDueItem[] }>({
    method: 'GET',
    path: `${P}/retention/due`,
    action: 'retention.manage',
    mutation: false,
    status: 200,
  }),
  erase: route<EraseBody, LeadCardView>({
    method: 'POST',
    path: `${P}/leads/:id/erase`,
    action: 'retention.manage',
    mutation: true,
    status: 200,
  }),
  retain: route<RetainBody, LeadCardView>({
    method: 'POST',
    path: `${P}/leads/:id/retention`,
    action: 'retention.manage',
    mutation: true,
    status: 200,
  }),
  trafficPassport: route<void, TrafficPassport>({
    method: 'GET',
    path: `${P}/traffic/passport`,
    action: 'traffic.read',
    mutation: false,
    status: 200,
  }),
  trafficEvents: route<void, ListPage<TrafficEventView>>({
    method: 'GET',
    path: `${P}/traffic/events`,
    action: 'traffic.diagnostics',
    mutation: false,
    status: 200,
  }),
} as const;
