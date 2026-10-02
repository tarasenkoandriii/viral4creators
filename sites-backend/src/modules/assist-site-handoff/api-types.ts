/**
 * Передача человеку (Э3, агент H; ТЗ §3.2, §3.7, §2.8 №11–14) — формы REST
 * кабинета. TMA (T) повторяет их в `assist/src/lib/handoff-types.ts` и
 * разбирает строго (`assist/scripts/*.test.ts` сверяет поля с этим файлом).
 * Менять — через координатора; НЕОБЯЗАТЕЛЬНЫЕ поля добавлять можно (с
 * записью в отчёте).
 *
 * telegramId наружу — строкой (BigInt в JSON не живёт). Тексты посетителя
 * — МАСКИРОВАННЫЕ (как в базе, §4.7); текст оператора — как написал.
 */
import type {
  SiteAction,
  SiteAnswerSource,
  AnswerTrace,
} from '../assist-site-chat/chat-types';
import type { HandoffConfig } from './public/handoff-config';

export type { HandoffConfig };

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

/** Правила ранней эскалации (№13): словари uk/ru/en + флаги разметки позже (Э3-бис). */
export const ESCALATION_KINDS = [
  'irritation',
  'complaint',
  'refund',
  'wholesale',
  'sensitive',
] as const;
export type EscalationKind = (typeof ESCALATION_KINDS)[number];

/** Участник кабинета глазами экрана «Операторы» (GET /assist/account/operators). */
export interface OperatorView {
  memberId: string;
  telegramId: string;
  role: 'owner' | 'manager' | 'operator';
  assist: 'manager' | 'operator' | 'none';
  /** Нажал Start у бота Помощника — карточки до него дойдут. */
  botStarted: boolean;
  /** Бот заблокирован человеком (403 от Telegram). */
  botBlocked: boolean;
  isMe: boolean;
}

/** GET|PATCH /assist/sites/:id/handoff-settings */
export interface HandoffSettingsView {
  config: HandoffConfig;
  /** Медиана за 7 дней (минуты) или null — тогда виджет пишет текст владельца. */
  etaMinutes: number | null;
  /** Сейчас рабочее время по поясу сайта и есть кому писать. */
  availableNow: boolean;
  /** Почему недоступно сейчас (для подсказки владельцу). */
  unavailableReason: 'disabled' | 'off_hours' | 'no_operators' | null;
  operators: OperatorView[];
}

export interface HandoffSummary {
  /** Сводка по МАСКИРОВАННЫМ сообщениям (№14). */
  text: string;
  lang: string;
  /** model — вызов модели; fallback — последние реплики без модели (бюджет/сбой). */
  source: 'model' | 'fallback';
}

export interface HandoffDraft {
  /** Черновик ответа оператору из знаний «Сайта» (№11); пусто — источников нет. */
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
  /** identify посетителя: только «есть/проверен», без значений (их видит карточка лида). */
  identity: { present: boolean; verified: boolean | null };
}

export interface ConversationMessageView {
  id: string;
  role: 'visitor' | 'assistant' | 'operator' | 'system';
  text: string;
  lang: string | null;
  /** Перевод (№12): для посетителя — на язык оператора; для оператора — оригинал. */
  translation: { lang: string; text: string } | null;
  sources: SiteAnswerSource[];
  actions: SiteAction[];
  rating: -1 | 1 | null;
  flags: string[];
  /** «Почему так ответил» (№34) — только assist: manager и владелец; оператору null. */
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
  /** Последняя реплика посетителя (маскированная), ≤ 120 символов. */
  preview: string;
  messages: number;
  handoff: Pick<
    HandoffView,
    'id' | 'state' | 'requestedAt' | 'assignedToMe'
  > | null;
  hasLead: boolean;
}

/**
 * GET /assist/sites/:id/conversations?view=&cursor=&from=&to=&outcome=&flagged=&lang=
 *   view: handoff (ждут/в работе — умолчание оператора) | mine | all (только manager).
 * Оператор (`assist: operator`) видит ТОЛЬКО диалоги с передачей (§5-тер.13
 * «свои передачи и лиды»); `all` для него — 403.
 */
export interface ConversationListQuery {
  view: 'handoff' | 'mine' | 'all';
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

/** POST …/conversations/:cid/reply — текст оператора (переводится на язык посетителя, если включено). */
export interface OperatorReplyRequest {
  text: string;
  /** Отправить как есть без перевода (оператор пишет на языке посетителя). */
  noTranslate?: boolean;
}

export interface OperatorReplyResult {
  messageId: string;
  /** Что увидит посетитель (после перевода). */
  sentText: string;
  translated: boolean;
}

/** POST …/conversations/:cid/take — гонка двух операторов: один `taken`, второй `already_taken`. */
export interface TakeResult {
  result: 'taken' | 'already_taken' | 'not_waiting';
  handoff: HandoffView;
}

/** PATCH /sites/account/members/:memberId (site-core, владелец кабинета). */
export interface MemberPatchRequest {
  role?: 'manager' | 'operator';
  productRoles?: Partial<Record<'qa' | 'assist' | 'assistAdmin', string>>;
}

/** Коды ошибок кабинета передачи (UPPER_SNAKE, конверт §5 контракта Э2). */
export const HANDOFF_ERROR_CODES = [
  'HANDOFF_CONFIG_INVALID',
  'HANDOFF_NOT_FOUND',
  'HANDOFF_NOT_ASSIGNED',
  'HANDOFF_CLOSED',
  'REPLY_INVALID',
  'MEMBER_NOT_FOUND',
  'MEMBER_LAST_OWNER',
  /** Интеграция Э3: PATCH участника — роль не manager|operator или права не по форме (400). */
  'MEMBER_ROLES_INVALID',
] as const;
export type HandoffErrorCode = (typeof HANDOFF_ERROR_CODES)[number];
