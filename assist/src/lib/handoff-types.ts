/**
 * Передача человеку и лента диалогов (Э3, сервер — агент H) — повтор
 * `sites-backend/src/modules/assist-site-handoff/api-types.ts` и
 * `public/handoff-config.ts`. `scripts/e3-api.test.ts` сверяет перечни
 * (импортом серверного модуля) и поля интерфейсов (по тексту файла).
 *
 * Тексты посетителя — маскированные (как в базе); текст оператора — как
 * написал. Всё рисуется ТЕКСТОМ (никакого HTML).
 */

export const HANDOFF_STATES = [
  'waiting',
  'active',
  'closed',
  'missed',
  'cancelled',
] as const;
export type HandoffState = (typeof HANDOFF_STATES)[number];

export const HANDOFF_REASONS = [
  'visitor',
  'escalation',
  'no_answer',
  'scenario',
] as const;
export type HandoffReason = (typeof HANDOFF_REASONS)[number];

export const ESCALATION_KINDS = [
  'irritation',
  'complaint',
  'refund',
  'wholesale',
  'sensitive',
] as const;
export type EscalationKind = (typeof ESCALATION_KINDS)[number];

export const WEEKDAYS = [
  'mon',
  'tue',
  'wed',
  'thu',
  'fri',
  'sat',
  'sun',
] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export const OPERATOR_LANGS = ['uk', 'ru', 'en'] as const;
export type OperatorLang = (typeof OPERATOR_LANGS)[number];

export const HANDOFF_LIMITS = {
  waitMinutes: { min: 1, max: 60, default: 5 },
  remindAfterMinutes: { min: 1, max: 60, default: 3 },
  maxReminders: { min: 0, max: 5, default: 2 },
  idleCloseHours: { min: 1, max: 72, default: 24 },
  templates: 10,
  templateText: 500,
  etaText: 140,
  intervalsPerDay: 3,
} as const;

export interface HandoffConfig {
  schema: 1;
  enabled: boolean;
  hours: Partial<Record<Weekday, Array<{ from: string; to: string }>>>;
  waitMinutes: number;
  remindAfterMinutes: number;
  maxReminders: number;
  idleCloseHours: number;
  etaText: Partial<Record<OperatorLang, string>>;
  templates: Array<{ id: string; title: string; text: string }>;
  operatorLang: OperatorLang;
  translate: boolean;
  draft: boolean;
  escalation: Record<EscalationKind, boolean>;
}

export interface OperatorView {
  memberId: string;
  telegramId: string;
  role: 'owner' | 'manager' | 'operator';
  assist: 'manager' | 'operator' | 'none';
  botStarted: boolean;
  botBlocked: boolean;
  isMe: boolean;
}

export interface HandoffSettingsView {
  config: HandoffConfig;
  etaMinutes: number | null;
  availableNow: boolean;
  unavailableReason: 'disabled' | 'off_hours' | 'no_operators' | null;
  operators: OperatorView[];
}

/** Источник ответа (номер из промпта, URL — только https). */
export interface SiteAnswerSource {
  n: number;
  url: string | null;
  title: string | null;
}

export type SiteAction =
  | { kind: 'link'; label: string; url: string }
  | { kind: 'lead'; label: string }
  | { kind: 'handoff'; label: string };

export const ANSWER_PATHS = [
  'faq',
  'cache',
  'model',
  'template',
  'refusal',
] as const;
export type AnswerPath = (typeof ANSWER_PATHS)[number];

/** «Почему так ответил» (№34) — только manager/owner; оператору null. */
export interface AnswerTrace {
  knowledgeVersion: number;
  configVersion: number;
  path: AnswerPath;
  chunkIds: string[];
  faqId: string | null;
  rule: string | null;
  cache: boolean;
  translated: boolean;
}

export interface HandoffSummary {
  text: string;
  lang: string;
  source: 'model' | 'fallback';
}

export interface HandoffDraft {
  text: string;
  lang: string;
  sources: SiteAnswerSource[];
}

export interface HandoffView {
  id: string;
  state: HandoffState;
  reason: HandoffReason;
  escalation: EscalationKind | null;
  requestedAt: string;
  takenAt: string | null;
  timeoutAt: string;
  closedAt: string | null;
  assignedMemberId: string | null;
  assignedToMe: boolean;
  visitorLang: string | null;
  operatorLang: string | null;
  summary: HandoffSummary | null;
  draft: HandoffDraft | null;
  identity: { present: boolean; verified: boolean | null };
}

export const MESSAGE_ROLES = [
  'visitor',
  'assistant',
  'operator',
  'system',
] as const;
export type MessageRole = (typeof MESSAGE_ROLES)[number];

export interface ConversationMessageView {
  id: string;
  role: MessageRole;
  text: string;
  lang: string | null;
  translation: { lang: string; text: string } | null;
  sources: SiteAnswerSource[];
  actions: SiteAction[];
  rating: -1 | 1 | null;
  flags: string[];
  trace: AnswerTrace | null;
  authorIsMe: boolean;
  createdAt: string;
}

export interface ConversationListItem {
  id: string;
  createdAt: string;
  lastMessageAt: string;
  pageUrl: string | null;
  locale: string | null;
  outcome: string | null;
  flagged: boolean;
  openedBy: string | null;
  preview: string;
  messages: number;
  handoff: Pick<
    HandoffView,
    'id' | 'state' | 'requestedAt' | 'assignedToMe'
  > | null;
  hasLead: boolean;
}

export const CONVERSATION_VIEWS = ['handoff', 'mine', 'all'] as const;
export type ConversationViewKind = (typeof CONVERSATION_VIEWS)[number];

export interface ConversationListQuery {
  view: ConversationViewKind;
  cursor: string | null;
  from: string | null;
  to: string | null;
  outcome: string | null;
  flagged: boolean | null;
  lang: string | null;
  limit: number;
}

export interface ConversationListView {
  items: ConversationListItem[];
  nextCursor: string | null;
}

export interface ConversationView {
  id: string;
  createdAt: string;
  lastMessageAt: string;
  pageUrl: string | null;
  locale: string | null;
  outcome: string | null;
  openedBy: string | null;
  messages: ConversationMessageView[];
  handoff: HandoffView | null;
  lead: { id: string; fieldNames: string[]; createdAt: string } | null;
}

export interface OperatorReplyRequest {
  text: string;
  noTranslate?: boolean;
}

export interface OperatorReplyResult {
  messageId: string;
  sentText: string;
  translated: boolean;
}

export interface TakeResult {
  result: 'taken' | 'already_taken' | 'not_waiting';
  handoff: HandoffView;
}

export interface MemberPatchRequest {
  role?: 'manager' | 'operator';
  productRoles?: Partial<Record<'qa' | 'assist' | 'assistAdmin', string>>;
}

export const HANDOFF_ERROR_CODES = [
  'HANDOFF_CONFIG_INVALID',
  'HANDOFF_NOT_FOUND',
  'HANDOFF_NOT_ASSIGNED',
  'HANDOFF_CLOSED',
  'REPLY_INVALID',
  'MEMBER_NOT_FOUND',
  'MEMBER_LAST_OWNER',
  'MEMBER_ROLES_INVALID',
] as const;
export type HandoffErrorCode = (typeof HANDOFF_ERROR_CODES)[number];
