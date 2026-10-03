/**
 * Клиент публичного API виджета `/widget/v1/*` из iframe (тот же origin).
 * Типы — повтор `sites-backend/src/modules/assist-widget/api-types.ts` и
 * `assist-site-chat/chat-types.ts` (стык W1 ↔ W2, контракт Э2 §5); ответы
 * разбираются СТРОГО: сервер — доверенный, но ошибка версии не должна
 * превращаться в «undefined» в DOM. Тексты — только как данные.
 */
import {
  WIDGET_PREVIEW_SESSION_HEADER,
  WIDGET_VOICE_TEST_HEADER,
  WIDGET_VISITOR_TOKEN_HEADER,
} from '../shared/brand';
import {
  defaultViewConfig,
  isObj,
  mergeView,
  text,
  type LeadField,
  type UiLang,
  type ViewConfig,
} from '../shared/config';
import { UI_ELEMENT_ID, cleanSelector } from '../shared/protocol';

// ── типы (повтор api-types.ts / chat-types.ts) ─────────────────────────────

export type SiteAction =
  | { kind: 'link'; label: string; url: string }
  | { kind: 'lead'; label: string }
  | { kind: 'handoff'; label: string }
  /** Э6: ролик обучалки сайта — ссылку iframe берёт по клику (`POST /widget/v1/video`). */
  | { kind: 'video'; label: string; videoId: string; title: string }
  /** Э6: подсветка элемента страницы — селектор и подпись из карты сервера. */
  | {
      kind: 'highlight';
      label: string;
      elementId: string;
      selector: string;
      caption: string;
    };

/** Э6: `POST /widget/v1/video` — подписанная ссылка своего origin. */
export interface WidgetVideoLink {
  url: string;
  title: string;
  expiresAt: string;
}

const VIDEO_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** Путь подписанной ссылки: только свой origin, только этот маршрут. */
const VIDEO_PATH = /^\/widget\/v1\/video\/v1\.[A-Za-z0-9_.-]{1,300}$/;

export function parseVideoLink(v: unknown): WidgetVideoLink {
  if (!isObj(v) || typeof v.url !== 'string' || !VIDEO_PATH.test(v.url))
    throw new ApiError('BAD_RESPONSE', 0);
  return {
    url: v.url,
    title: text(v.title, 120) ?? '',
    expiresAt: typeof v.expiresAt === 'string' ? v.expiresAt : '',
  };
}

export interface SiteAnswerSource {
  n: number;
  url: string | null;
  title: string | null;
}

export const STREAM_ERRORS = [
  'disabled',
  'site_quota',
  'platform_budget',
  'rate_limited',
  'upstream',
  'origin_denied',
  'bad_request',
] as const;
export type StreamErrorCode = (typeof STREAM_ERRORS)[number];

/**
 * Код REST (UPPER_SNAKE, `WIDGET_ERROR_CODES` сервера) → поведение как у
 * события стрима. `UPSTREAM` — JSON-путь чата при сбое модели (502):
 * «повторите», а не общая ошибка. Остальные коды — общий текст.
 */
const REST_TO_STREAM: Record<string, StreamErrorCode> = {
  WIDGET_DISABLED: 'disabled',
  SITE_QUOTA: 'site_quota',
  PLATFORM_BUDGET: 'platform_budget',
  RATE_LIMITED: 'rate_limited',
  ORIGIN_DENIED: 'origin_denied',
  UPSTREAM: 'upstream',
};
export function streamCodeOfRest(code: string): StreamErrorCode | null {
  return Object.prototype.hasOwnProperty.call(REST_TO_STREAM, code)
    ? REST_TO_STREAM[code]
    : null;
}

export type WidgetChatEvent =
  | { type: 'meta'; conversationId: string; messageId: string; replay: boolean }
  | { type: 'sources'; items: SiteAnswerSource[] }
  | { type: 'token'; t: string }
  | { type: 'actions'; items: SiteAction[] }
  | { type: 'done' }
  | { type: 'error'; code: StreamErrorCode; message: string }
  /** Э3: вопрос ушёл человеку (открыта передача) — модели нет, следом done. */
  | { type: 'handoff'; state: 'waiting' | 'active'; relayed: boolean };

/** Э3: передача человеку глазами посетителя (VisitorHandoffView, H). */
export const HANDOFF_STATES = [
  'waiting',
  'active',
  'closed',
  'missed',
  'cancelled',
] as const;
export type HandoffState = (typeof HANDOFF_STATES)[number];
export interface VisitorHandoffView {
  id: string;
  state: HandoffState;
  requestedAt: string;
  takenAt: string | null;
  timeoutAt: string;
}

/** POST /widget/v1/handoff — ответ. */
export type WidgetHandoffResponse =
  | {
      mode: 'human';
      handoff: VisitorHandoffView;
      etaMinutes: number | null;
      existing: boolean;
    }
  | {
      mode: 'lead';
      reason:
        'disabled' | 'off_hours' | 'no_operators' | 'no_conversation' | null;
    };

export interface WidgetSessionRequest {
  pk: string;
  parentOrigin: string;
  resumeKey?: string | null;
  previewSession?: string | null;
}

export interface WidgetSessionResponse {
  visitorToken: string;
  expiresAt: string;
  resumeKey: string | null;
  resumed: boolean;
  resumeLost: boolean;
  preview: boolean;
}

export type StreamState = 'streaming' | 'complete' | 'partial' | 'refused';

export interface WidgetMessageView {
  id: string;
  role: 'visitor' | 'assistant' | 'operator' | 'system';
  text: string;
  sources: SiteAnswerSource[];
  actions: SiteAction[];
  streamState: StreamState;
  rating: -1 | 1 | null;
  createdAt: string;
}

export interface WidgetStateView {
  conversation: {
    id: string;
    stateVersion: number;
    messages: WidgetMessageView[];
    streamingMessageId: string | null;
    lastMessageAt: string;
    /** Э3: последняя передача человеку (undefined — сервер Э2). */
    handoff: VisitorHandoffView | null;
  } | null;
  previousConversationId: string | null;
}

export interface WidgetChatRequest {
  conversationId: string | null;
  clientRequestId: string;
  question: string;
  page: { url: string | null; title: string | null };
  context: Record<string, string | number> | null;
  uiLang: UiLang | null;
}

export interface WidgetChatJsonResponse {
  conversationId: string;
  messageId: string;
  text: string;
  sources: SiteAnswerSource[];
  actions: SiteAction[];
  refused: boolean;
  streaming: boolean;
  /** Э3: вопрос ушёл человеку — ответа модели нет. */
  handoff: { state: 'waiting' | 'active'; relayed: boolean } | null;
}

export interface WidgetStreamChunk {
  messageId: string;
  text: string;
  offset: number;
  streamState: StreamState;
  sources: SiteAnswerSource[];
  actions: SiteAction[];
}

export interface WidgetLeadRequest {
  conversationId: string | null;
  fields: Partial<Record<LeadField, string>>;
  consent: boolean;
  uiLang: UiLang;
  pageUrl: string | null;
}

export interface WidgetPreviewExchangeResponse {
  previewSession: string;
  expiresAt: string;
  config: ViewConfig;
}

// ── строгий разбор ─────────────────────────────────────────────────────────

/** Ответ не той формы — для пользователя это «не удалось», не падение. */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number
  ) {
    super(code);
  }
}

const MAX_TEXT = 20000;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function id(v: unknown): string {
  if (typeof v === 'string' && ID_RE.test(v)) return v;
  throw new ApiError('BAD_RESPONSE', 0);
}

function str(v: unknown, max: number): string {
  const t = text(v, max);
  if (t === null) throw new ApiError('BAD_RESPONSE', 0);
  return t;
}

function int(v: unknown): number {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return v;
  throw new ApiError('BAD_RESPONSE', 0);
}

function list<T>(v: unknown, item: (x: unknown) => T | null, max = 20): T[] {
  if (!Array.isArray(v)) return [];
  const out: T[] = [];
  for (const x of v.slice(0, max)) {
    const r = item(x);
    if (r) out.push(r);
  }
  return out;
}

export function parseSource(v: unknown): SiteAnswerSource | null {
  if (!isObj(v) || typeof v.n !== 'number' || !Number.isInteger(v.n))
    return null;
  return {
    n: v.n,
    url: typeof v.url === 'string' && v.url.length <= 2000 ? v.url : null,
    title: text(v.title, 200),
  };
}

export function parseAction(v: unknown): SiteAction | null {
  if (!isObj(v)) return null;
  const label = text(v.label, 80);
  if (!label) return null;
  if (v.kind === 'link')
    return typeof v.url === 'string' && v.url.length <= 2000
      ? { kind: 'link', label, url: v.url }
      : null;
  if (v.kind === 'lead' || v.kind === 'handoff') return { kind: v.kind, label };
  if (v.kind === 'video')
    return typeof v.videoId === 'string' && VIDEO_ID.test(v.videoId)
      ? {
          kind: 'video',
          label,
          videoId: v.videoId,
          title: text(v.title, 120) ?? label,
        }
      : null;
  if (v.kind === 'highlight') {
    const selector = cleanSelector(v.selector);
    const caption = text(v.caption, 80);
    return typeof v.elementId === 'string' &&
      UI_ELEMENT_ID.test(v.elementId) &&
      selector &&
      caption
      ? { kind: 'highlight', label, elementId: v.elementId, selector, caption }
      : null;
  }
  return null;
}

const STATES: readonly StreamState[] = [
  'streaming',
  'complete',
  'partial',
  'refused',
];

function streamState(v: unknown): StreamState {
  return STATES.includes(v as StreamState) ? (v as StreamState) : 'complete';
}

export function parseMessage(v: unknown): WidgetMessageView | null {
  if (!isObj(v)) return null;
  const role = v.role;
  if (
    role !== 'visitor' &&
    role !== 'assistant' &&
    role !== 'operator' &&
    role !== 'system'
  )
    return null;
  try {
    return {
      id: id(v.id),
      role,
      text: str(v.text, MAX_TEXT),
      sources: list(v.sources, parseSource),
      actions: list(v.actions, parseAction, 3),
      streamState: streamState(v.streamState),
      rating: v.rating === 1 || v.rating === -1 ? v.rating : null,
      createdAt: typeof v.createdAt === 'string' ? v.createdAt : '',
    };
  } catch {
    return null;
  }
}

export function parseSession(v: unknown): WidgetSessionResponse {
  if (!isObj(v)) throw new ApiError('BAD_RESPONSE', 0);
  return {
    visitorToken: str(v.visitorToken, 4096),
    expiresAt: typeof v.expiresAt === 'string' ? v.expiresAt : '',
    resumeKey:
      typeof v.resumeKey === 'string' &&
      /^[A-Za-z0-9_-]{16,128}$/.test(v.resumeKey)
        ? v.resumeKey
        : null,
    resumed: v.resumed === true,
    resumeLost: v.resumeLost === true,
    preview: v.preview === true,
  };
}

function isoOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length <= 40 && !isNaN(Date.parse(v))
    ? v
    : null;
}

export function parseHandoffView(v: unknown): VisitorHandoffView | null {
  if (!isObj(v) || !HANDOFF_STATES.includes(v.state as HandoffState))
    return null;
  try {
    return {
      id: id(v.id),
      state: v.state as HandoffState,
      requestedAt: isoOrNull(v.requestedAt) || '',
      takenAt: isoOrNull(v.takenAt),
      timeoutAt: isoOrNull(v.timeoutAt) || '',
    };
  } catch {
    return null;
  }
}

export function parseHandoffResponse(v: unknown): WidgetHandoffResponse {
  if (isObj(v) && v.mode === 'human') {
    const h = parseHandoffView(v.handoff);
    if (h)
      return {
        mode: 'human',
        handoff: h,
        etaMinutes:
          typeof v.etaMinutes === 'number' && Number.isInteger(v.etaMinutes)
            ? v.etaMinutes
            : null,
        existing: v.existing === true,
      };
  }
  // Ответ не той формы — безопасный путь: форма заявки (§3.7 п.2).
  const r = isObj(v) ? v.reason : null;
  return {
    mode: 'lead',
    reason:
      r === 'disabled' ||
      r === 'off_hours' ||
      r === 'no_operators' ||
      r === 'no_conversation'
        ? r
        : null,
  };
}

function relayedState(
  v: unknown
): { state: 'waiting' | 'active'; relayed: boolean } | null {
  return isObj(v) && (v.state === 'waiting' || v.state === 'active')
    ? { state: v.state, relayed: v.relayed === true }
    : null;
}

export function parseState(v: unknown): WidgetStateView {
  if (!isObj(v)) throw new ApiError('BAD_RESPONSE', 0);
  const c = v.conversation;
  return {
    conversation: isObj(c)
      ? {
          id: id(c.id),
          stateVersion: int(c.stateVersion),
          messages: list(c.messages, parseMessage, 500),
          streamingMessageId:
            typeof c.streamingMessageId === 'string' &&
            ID_RE.test(c.streamingMessageId)
              ? c.streamingMessageId
              : null,
          lastMessageAt:
            typeof c.lastMessageAt === 'string' ? c.lastMessageAt : '',
          handoff: parseHandoffView(c.handoff),
        }
      : null,
    previousConversationId:
      typeof v.previousConversationId === 'string' &&
      ID_RE.test(v.previousConversationId)
        ? v.previousConversationId
        : null,
  };
}

export function parseChatJson(v: unknown): WidgetChatJsonResponse {
  if (!isObj(v)) throw new ApiError('BAD_RESPONSE', 0);
  const handoff = relayedState(v.handoff);
  return {
    conversationId: id(v.conversationId),
    // Вопрос ушёл человеку — ответа модели (и его id) нет.
    messageId: handoff && v.messageId === '' ? '' : id(v.messageId),
    handoff,
    text: str(v.text ?? '', MAX_TEXT),
    sources: list(v.sources, parseSource),
    actions: list(v.actions, parseAction, 3),
    refused: v.refused === true,
    streaming: v.streaming === true,
  };
}

export function parseChunk(v: unknown): WidgetStreamChunk {
  if (!isObj(v)) throw new ApiError('BAD_RESPONSE', 0);
  return {
    messageId: id(v.messageId),
    text: str(v.text ?? '', MAX_TEXT),
    offset: int(v.offset),
    streamState: streamState(v.streamState),
    sources: list(v.sources, parseSource),
    actions: list(v.actions, parseAction, 3),
  };
}

/** Событие стрима; неизвестный тип/форма — null (игнор). */
export function parseChatEvent(
  type: string,
  data: unknown
): WidgetChatEvent | null {
  if (!isObj(data)) return null;
  switch (type) {
    case 'meta':
      try {
        return {
          type: 'meta',
          conversationId: id(data.conversationId),
          messageId: id(data.messageId),
          replay: data.replay === true,
        };
      } catch {
        return null;
      }
    case 'sources':
      return { type: 'sources', items: list(data.items, parseSource) };
    case 'token':
      return typeof data.t === 'string'
        ? { type: 'token', t: data.t.slice(0, MAX_TEXT) }
        : null;
    case 'actions':
      return { type: 'actions', items: list(data.items, parseAction, 3) };
    case 'done':
      return { type: 'done' };
    case 'handoff': {
      const h = relayedState(data);
      return h ? { type: 'handoff', ...h } : null;
    }
    case 'error':
      return {
        type: 'error',
        code: STREAM_ERRORS.includes(data.code as StreamErrorCode)
          ? (data.code as StreamErrorCode)
          : 'upstream',
        message: text(data.message, 300) ?? '',
      };
    default:
      return null;
  }
}

export function parsePreviewExchange(
  v: unknown
): WidgetPreviewExchangeResponse {
  if (!isObj(v)) throw new ApiError('BAD_RESPONSE', 0);
  return {
    previewSession: str(v.previewSession, 1024),
    expiresAt: typeof v.expiresAt === 'string' ? v.expiresAt : '',
    config: mergeView(defaultViewConfig(), v.config),
  };
}

/** Конверт `{ success, data }` / `{ success:false, error:{ code } }`. */
export function unwrap(status: number, body: unknown): unknown {
  if (isObj(body) && body.success === true) return body.data;
  const err = isObj(body) && isObj(body.error) ? body.error : null;
  const code =
    err && typeof err.code === 'string' && /^[A-Z_]{1,40}$/.test(err.code)
      ? err.code
      : 'HTTP_' + status;
  throw new ApiError(code, status);
}

// ── транспорт ──────────────────────────────────────────────────────────────

export interface Auth {
  token: string | null;
  preview: string | null;
  /** Э6-бис (г): тестовая сессия мастера проверки голосового управления. */
  vtest?: string | null;
}

/**
 * Э6-бис (г), канарейка (§5-бис.12): выпуск, из которого загружен chat.js
 * (`/v1/r/<выпуск>/chat.js` — так его отдаёт кадр iframe сайту из
 * канарейки). Ленивые чанки чата (голос) — из того же каталога; выпуск
 * уходит в план (монитор сравнивает `done` канарейки со стабильным).
 */
export const CHAT_RELEASE: string | null = (() => {
  try {
    const s =
      typeof document !== 'undefined'
        ? (document.currentScript as HTMLScriptElement | null)?.src || ''
        : '';
    const m = /\/v1\/r\/([a-z0-9][a-z0-9.-]{0,23})\//.exec(s);
    return m ? m[1] : null;
  } catch {
    return null;
  }
})();
export const CHUNK_BASE = CHAT_RELEASE ? `/v1/r/${CHAT_RELEASE}/` : '/v1/';

export function headers(
  auth: Auth,
  extra?: Record<string, string>
): Record<string, string> {
  const h: Record<string, string> = { ...extra };
  if (auth.token) h[WIDGET_VISITOR_TOKEN_HEADER] = auth.token;
  if (auth.preview) h[WIDGET_PREVIEW_SESSION_HEADER] = auth.preview;
  if (auth.vtest) h[WIDGET_VOICE_TEST_HEADER] = auth.vtest;
  return h;
}

export async function request(
  method: 'GET' | 'POST',
  path: string,
  auth: Auth,
  body?: unknown
): Promise<unknown> {
  const res = await fetch(path, {
    method,
    // CHIPS-cookie указателя — тот же origin, но явно (контракт §4 W1).
    credentials: 'include',
    headers: headers(
      auth,
      body === undefined ? {} : { 'Content-Type': 'application/json' }
    ),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return unwrap(res.status, json);
}
