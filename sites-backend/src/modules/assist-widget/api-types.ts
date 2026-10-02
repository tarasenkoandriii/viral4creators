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
  WidgetIdentity,
} from '../assist-site-chat/chat-types';
import type { PublicGoal } from '../assist-analytics/goal-types';
import type { WidgetEventKind } from '../assist-analytics/public/event-counts.service';
import type { PublicEngagementConfig } from '../assist-site-setup/engagement-config';
import type { LeadField } from '../assist-site-setup/leads-config';
import type { WidgetConfig } from '../assist-site-setup/widget-config';
import type { VisitorHandoffView } from '../assist-site-handoff/public/handoff-intake.service';
import type { WidgetVoiceConfig } from '../assist-site-voice/api-types';

export type {
  SiteAction,
  SiteAnswerSource,
  WidgetChatEvent,
  WidgetIdentity,
  PublicGoal,
  PublicEngagementConfig,
  VisitorHandoffView,
  WidgetEventKind,
};

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
  /**
   * Э3 (необязательные — кэш конфига 5 мин и старые загрузчики):
   * триггеры/лимиты/сценарии опубликованного вида (T, engagement-config.ts);
   */
  engagement?: PublicEngagementConfig;
  /** передача человеку включена (решение «сейчас» — `POST handoff`, H); */
  handoff?: {
    enabled: boolean;
    etaMinutes: number | null;
    etaText: Partial<Record<'uk' | 'ru' | 'en', string>>;
  };
  /** активные цели с детекторами загрузчика (A, goal-types.ts). */
  goals?: PublicGoal[];
  /**
   * Э5 (необязательное): голос — кнопка микрофона и/или «озвучить ответ»;
   * нет поля — голоса нет (тариф, владелец, рубильник, ключ, lead_only).
   */
  voice?: WidgetVoiceConfig;
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
    /**
     * Э3: последняя передача человеку этого диалога (открытая или закрытая
     * < 24 ч) — iframe опрашивает `state` раз в 3 с, пока она waiting/active
     * и вкладка видима (§3.7 п.4); `missed` — показать форму заявки.
     */
    handoff?: VisitorHandoffView | null;
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
  /** Э3: `user` | `proactive:<ключ>` | `scenario:<ключ>` — только для нового диалога. */
  openedBy?: string | null;
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
  /**
   * Э3 (W, необязательное): вопрос ушёл человеку (событие стрима `handoff`)
   * — ответа модели нет, `messageId` пуст; iframe опрашивает `state`.
   */
  handoff?: { state: 'waiting' | 'active'; relayed: boolean } | null;
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
  /** Э3: `V4CAssist('identify')` — только вместе с лидом (К-3). */
  identity?: WidgetIdentity | null;
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

/** POST /widget/v1/handoff — Э3 (§3.7): «позвать человека». */
export interface WidgetHandoffRequest {
  conversationId: string | null;
  uiLang: 'uk' | 'ru' | 'en' | null;
  pageUrl: string | null;
  /** Сценарий закончился передачей (ScenarioFinal.kind = handoff). */
  scenarioKey?: string | null;
  identity?: WidgetIdentity | null;
}

/**
 * `human` — передача создана/уже открыта: показать «Обычно отвечаем за ~N
 * минут», опрашивать state; `lead` — нерабочее время / нет операторов /
 * выключено / нет диалога → сразу форма заявки (§3.7 п.2).
 */
export type WidgetHandoffResponse =
  | {
      mode: 'human';
      handoff: VisitorHandoffView;
      etaMinutes: number | null;
      existing: boolean;
    }
  | {
      mode: 'lead';
      reason?: 'disabled' | 'off_hours' | 'no_operators' | 'no_conversation';
    };

/** POST /widget/v1/handoff/cancel — посетитель передумал (только waiting). */
export interface WidgetHandoffCancelRequest {
  conversationId: string;
}

/**
 * POST /widget/v1/event — счётчики событий (§4.16; A — EventCounts). С
 * СТРАНИЦЫ (загрузчик): Origin = verified public-хост сайта; без cookie;
 * батч ≤ 20, тело ≤ 4 КБ; неизвестное поле — 400. Ответ 204.
 */
export interface WidgetEventBatch {
  pk: string;
  events: Array<{ kind: WidgetEventKind; key: string | null }>;
}

/**
 * POST /widget/v1/goal (§5-тер.1). Два входа одного маршрута:
 *  - из загрузчика (Origin = страница сайта, тело с `pk`, без токена) —
 *    attribution unassisted;
 *  - из iframe (visitor-token в заголовке, Origin виджета) — с диалогом и
 *    кликом по действию помощника (direct/assisted).
 * 204 — принято/дубль/тихо отброшено; 422 GOAL_ORDER_ID_INVALID — orderId
 * похож на контакт (§5-тер.16 п.1).
 */
export interface WidgetGoalRequest {
  pk?: string;
  goalKey: string;
  detector: 'url' | 'click' | 'form_submit' | 'js';
  docId: string;
  path: string | null;
  orderId?: string | null;
  value?: number | null;
  currency?: string | null;
  /** Только из iframe: */
  conversationId?: string | null;
  lastAssistClickAt?: string | null;
  assist?: {
    proactive: string | null;
    scenario: string | null;
    link: boolean;
  } | null;
}

/** POST /widget/v1/goal-picker/session — обмен `?v4c_goal=` (30 мин, один раз; Origin = verified-хост токена). */
export interface WidgetGoalPickerSessionRequest {
  pk: string;
  token: string;
}
export interface WidgetGoalPickerSessionResponse {
  pickerSession: string;
  expiresAt: string;
}

/** POST /widget/v1/goal-picker/pick — выбранный элемент → assist_site_preview_tokens.result. */
export interface WidgetGoalPickRequest {
  pickerSession: string;
  kind: 'click' | 'form_submit';
  descriptor: import('../assist-analytics/goal-types').ElementDescriptor;
  path: string;
  label: string;
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
  // Э3:
  'GOAL_ORDER_ID_INVALID',
  'PICKER_INVALID',
  'EVENT_INVALID',
  // Э5 (голос, assist-site-voice): голос выключен (тариф, владелец,
  // рубильник, нет ключа); исчерпан потолок голоса сайта, деньги дня или
  // единицы — чат продолжает текстом; речь не распознана; запись не того
  // формата или размера.
  'VOICE_UNAVAILABLE',
  'VOICE_LIMIT',
  'VOICE_NOT_HEARD',
  'AUDIO_INVALID',
] as const;
export type WidgetErrorCode = (typeof WIDGET_ERROR_CODES)[number];
