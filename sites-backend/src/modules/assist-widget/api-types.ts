/**
 * Публичный протокол виджета `/widget/v1/*` (ТЗ §4.16, §4-бис.9, §4.8) —
 * стык W2 (сервер) ↔ W1 (iframe-чат: widget/src/chat/api.ts повторяет эти
 * типы и разбирает ответы строго). REST — конверт `{ success, data }` /
 * `{ success:false, error:{ code UPPER_SNAKE, message } }`; стрим чата — SSE
 * (`event: <type>\ndata: <json>`) или JSON при `Accept: application/json`.
 * Менять — только через координатора.
 *
 * Никогда не уходят наружу: ipHash, accountId, telegramId, сырой resumeKey
 * (кроме ОДНОГО раза при выдаче — в теле для localStorage iframe), тексты
 * чужих посетителей, черновики владельца (кроме сессии предпросмотра).
 */
import type {
  SiteAction,
  SiteAnswerSource,
  WidgetChatEvent,
} from '../assist-site-chat/chat-types';
import type { LeadField } from '../assist-site-setup/leads-config';
import type { WidgetConfig } from '../assist-site-setup/widget-config';

export type { SiteAction, SiteAnswerSource, WidgetChatEvent };

/** GET /widget/v1/config?pk= — публичный (кэш 5 мин по pk, БЕЗ решения о допуске, §4.13 п.1). */
export interface WidgetPublicConfig {
  /** active — чат работает; lead_only — рубильник/квота: только форма заявки; off — не показывать кнопку. */
  status: 'active' | 'lead_only' | 'off';
  widgetVersion: number;
  /** Опубликованный вид без hosts; картинки — пути `/widget/v1/asset/<id>`. */
  config: Omit<WidgetConfig, 'hosts'>;
  /** Где показывать: только включённые verified-хосты (маски путей — для загрузчика). */
  hosts: Array<{ origin: string; pathMasks: string[]; hideOn: string[] }>;
  /** `V4CAssist('preview')` разрешён (флаг оператора, лендинг-ТЗ §4.3) — «к Л2». */
  allowClientPreview: boolean;
  lead: {
    fields: Array<{ field: LeadField; required: boolean }>;
    consentText: Partial<Record<'uk' | 'ru' | 'en', string>>;
  };
  /** Подсказки-вопросы (из знаний, если владелец не задал), по языкам. */
  suggestedQuestions: string[];
  poweredByUrl: string | null;
}

/** POST /widget/v1/session — тело. resumeKey — из localStorage iframe ИЛИ CHIPS-cookie. */
export interface WidgetSessionRequest {
  pk: string;
  /** Из location.ancestorOrigins[0] / document.referrer (§4.13 п.1б). */
  parentOrigin: string;
  resumeKey?: string | null;
  /** Сессия предпросмотра (sessionStorage iframe) — если есть. */
  previewSession?: string | null;
}

export interface WidgetSessionResponse {
  visitorToken: string;
  expiresAt: string;
  /** Только при выдаче нового указателя (32 байта base64url) — положить в localStorage iframe. */
  resumeKey: string | null;
  /** Восстановлено по указателю (§4-бис.1 «возврат через день»). */
  resumed: boolean;
  /** Указатель был, но не найден/чужой — новый посетитель (метрика resume_lost). */
  resumeLost: boolean;
  preview: boolean;
}

export interface WidgetMessageView {
  id: string;
  role: 'visitor' | 'assistant' | 'operator' | 'system';
  /** Маскированный текст из базы (§4.7). */
  text: string;
  sources: SiteAnswerSource[];
  actions: SiteAction[];
  streamState: 'streaming' | 'complete' | 'partial' | 'refused';
  rating: -1 | 1 | null;
  createdAt: string;
}

/** GET /widget/v1/state?since=<stateVersion> */
export interface WidgetStateView {
  /** null — у посетителя нет текущего диалога. */
  conversation: {
    id: string;
    stateVersion: number;
    /** since совпал — сообщений нет (ничего не изменилось). */
    messages: WidgetMessageView[];
    /** Идущий ответ — продолжение по `/messages/:id/stream`. */
    streamingMessageId: string | null;
    lastMessageAt: string;
  } | null;
  /** Предыдущий диалог старше resumeDialogMaxAgeMs — ссылка «предыдущий разговор». */
  previousConversationId: string | null;
}

/** POST /widget/v1/chat — тело. История — НЕ от клиента (§4.13 п.4). */
export interface WidgetChatRequest {
  conversationId: string | null;
  clientRequestId: string;
  question: string;
  page: { url: string | null; title: string | null };
  context: Record<string, string | number> | null;
  uiLang: 'uk' | 'ru' | 'en' | null;
}

/** JSON-ответ чата (Accept: application/json — запасной путь без SSE). */
export interface WidgetChatJsonResponse {
  conversationId: string;
  messageId: string;
  text: string;
  sources: SiteAnswerSource[];
  actions: SiteAction[];
  refused: boolean;
  /** Ответ ещё пишется другим экземпляром (повтор clientRequestId) — дочитать стримом. */
  streaming: boolean;
}

/** GET /widget/v1/messages/:id/stream?from=<offset> — продолжение стрима опросом (≤ 8 с ожидания). */
export interface WidgetStreamChunk {
  messageId: string;
  /** Текст с позиции from. */
  text: string;
  offset: number;
  streamState: WidgetMessageView['streamState'];
  sources: SiteAnswerSource[];
  actions: SiteAction[];
}

/** POST /widget/v1/lead */
export interface WidgetLeadRequest {
  conversationId: string | null;
  fields: Partial<Record<LeadField, string>>;
  consent: boolean;
  uiLang: 'uk' | 'ru' | 'en';
  pageUrl: string | null;
}

/** POST /widget/v1/feedback */
export interface WidgetFeedbackRequest {
  messageId: string;
  rating: 1 | -1;
}

/** POST /widget/v1/preview/exchange — одноразовый обмен токена (§3-бис.4). */
export interface WidgetPreviewExchangeRequest {
  pk: string;
  token: string;
  parentOrigin: string;
}
export interface WidgetPreviewExchangeResponse {
  previewSession: string;
  expiresAt: string;
  /** Черновой вид — только этой вкладке, без знаний «Админки», без расхода тарифа. */
  config: Omit<WidgetConfig, 'hosts'>;
}

/** POST /widget/v1/forget — право посетителя на удаление (§6.3). */
export interface WidgetForgetResponse {
  conversationsDeleted: number;
}

/** POST /widget/v1/handoff — Э2: «позвать человека» = форма лида (Э3 — передача). */
export interface WidgetHandoffResponse {
  mode: 'lead';
}

/** Коды ошибок REST виджета (UPPER_SNAKE); стрим — нижним регистром (chat-types). */
export const WIDGET_ERROR_CODES = [
  'ORIGIN_DENIED',
  'WIDGET_UNKNOWN_KEY',
  'WIDGET_DISABLED',
  'SESSION_REQUIRED',
  'SESSION_EXPIRED',
  'RATE_LIMITED',
  'QUESTION_TOO_LONG',
  'BAD_REQUEST',
  'NOT_FOUND',
  'PREVIEW_INVALID',
  'LEAD_INVALID',
  'CONSENT_REQUIRED',
  'SITE_QUOTA',
  'PLATFORM_BUDGET',
  // JSON-путь чата (`Accept` без SSE): модель упала/прервалась — 502 без
  // текста провайдера; в стриме это событие `error` с кодом `upstream`.
  'UPSTREAM',
] as const;
export type WidgetErrorCode = (typeof WIDGET_ERROR_CODES)[number];
