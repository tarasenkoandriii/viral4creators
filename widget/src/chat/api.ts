/**
 * Клиент публичного API виджета `/widget/v1/*` из iframe (тот же origin).
 * Типы — повтор `sites-backend/src/modules/assist-widget/api-types.ts` и
 * `assist-site-chat/chat-types.ts` (стык W1 ↔ W2, контракт Э2 §5); ответы
 * разбираются СТРОГО: сервер — доверенный, но ошибка версии не должна
 * превращаться в «undefined» в DOM. Тексты — только как данные.
 */
import {
  WIDGET_PREVIEW_SESSION_HEADER,
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

// ── типы (повтор api-types.ts / chat-types.ts) ─────────────────────────────

export type SiteAction =
  | { kind: 'link'; label: string; url: string }
  | { kind: 'lead'; label: string }
  | { kind: 'handoff'; label: string };

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
  | { type: 'error'; code: StreamErrorCode; message: string };

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
  return {
    conversationId: id(v.conversationId),
    messageId: id(v.messageId),
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
}

export function headers(
  auth: Auth,
  extra?: Record<string, string>
): Record<string, string> {
  const h: Record<string, string> = { ...extra };
  if (auth.token) h[WIDGET_VISITOR_TOKEN_HEADER] = auth.token;
  if (auth.preview) h[WIDGET_PREVIEW_SESSION_HEADER] = auth.preview;
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
