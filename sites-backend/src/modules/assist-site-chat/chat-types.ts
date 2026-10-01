/**
 * Типы конвейера ответа виджета (ТЗ §4.5–§4.9) — стык W3 (конвейер) ↔ W2
 * (публичный маршрут, SSE/JSON) ↔ W1 (iframe-чат, через api-types W2).
 * Менять — через координатора.
 *
 * Протокол стрима — тот же, что у лендинга (`ChatStreamEvent` из
 * shared/assist-chat-core: token/actions/done/error) + события Помощника
 * `meta` (id диалога и сообщения — до первого токена) и `sources` (§4.8).
 * Коды ошибок стрима — нижним регистром (§4.8); REST-конверт — UPPER_SNAKE.
 */
import type {
  ChatStreamEvent,
  ChatUsageSummary,
} from '../../shared/assist-chat-core';

/** Действия ответа «Сайта» в Э2 (§4.9): ссылка, форма лида, «позвать человека» (→ форма лида до Э3). */
export const SITE_ACTION_KINDS = ['link', 'lead', 'handoff'] as const;
export type SiteActionKind = (typeof SITE_ACTION_KINDS)[number];

export type SiteAction =
  | { kind: 'link'; label: string; url: string }
  | { kind: 'lead'; label: string }
  | { kind: 'handoff'; label: string };

/** Источник ответа — только номера из промпта (§4.6), URL — из метаданных фрагмента. */
export interface SiteAnswerSource {
  n: number;
  url: string | null;
  title: string | null;
}

/** Коды ошибок стрима (§4.8). */
export const WIDGET_STREAM_ERRORS = [
  'disabled',
  'site_quota',
  'platform_budget',
  'rate_limited',
  'upstream',
  'origin_denied',
  'bad_request',
] as const;
export type WidgetStreamErrorCode = (typeof WIDGET_STREAM_ERRORS)[number];

export type WidgetChatEvent =
  | { type: 'meta'; conversationId: string; messageId: string; replay: boolean }
  | { type: 'sources'; items: SiteAnswerSource[] }
  | ChatStreamEvent<SiteAction, WidgetStreamErrorCode>;

/** Как получен ответ (assist_site_messages.answerPath). */
export type AnswerPath = 'faq' | 'cache' | 'model' | 'template' | 'refusal';

/** Контекст сайта, который гвард origin (W2) уже проверил. */
export interface WidgetSiteContext {
  accountId: string;
  siteId: string;
  /** Опубликованные версии на момент запроса. */
  knowledgeVersion: number;
  configVersion: number;
  widgetVersion: number;
  /** Origin родителя — точный verified-хост (или льгота 72 ч). */
  parentOrigin: string;
  /** pk_test_ — только localhost/127.0.0.1; деньги и квота — как у live. */
  keyKind: 'live' | 'test';
  /** Сессия предпросмотра (конфигуратор/«посмотреть на сайте»): без расхода квоты диалогов. */
  preview: boolean;
}

/** Посетитель из visitor-token (W2). */
export interface WidgetVisitor {
  visitorId: string;
  /** Хеш IP: суточная соль + соль сайта (§6.4). */
  ipHash: string;
  /** Когда выдан токен — эвристика «бот» (§4.13 п.5). */
  tokenIssuedAt: Date;
  /** Сообщений в этой сессии (для замедления и лимита сессии). */
  sessionMessages: number;
}

export interface AskInput {
  site: WidgetSiteContext;
  visitor: WidgetVisitor;
  /** null — новый диалог. Чужой диалог (другой visitorId/сайт) — новый, не ошибка. */
  conversationId: string | null;
  /** UUID из iframe: повтор с тем же id в ТОМ ЖЕ диалоге — без нового вызова модели (§4-бис.4). */
  clientRequestId: string;
  /** Сырой вопрос (≤ maxQuestionChars). Живёт только в памяти; в базу — маскированным. */
  question: string;
  /** Страница посетителя — недоверенные данные (§4.6 п.5): URL только хоста сайта. */
  page: { url: string | null; title: string | null };
  /** `V4CAssist('context')` — недоверенные данные ≤ 500 символов, строки/числа. */
  context: Record<string, string | number> | null;
  /** Язык интерфейса/подсказка; язык ответа — язык вопроса (§3.5). */
  uiLang: string | null;
  /** Генерация доводится до конца даже при разрыве соединения (§4-бис.4). */
  signal?: AbortSignal;
}

export interface AskOutcome {
  conversationId: string;
  messageId: string;
  path: AnswerPath;
  usage: ChatUsageSummary;
  costMicroUsd: number;
  flags: string[];
}
