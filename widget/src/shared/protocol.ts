/**
 * Протокол postMessage загрузчик ↔ iframe-чат (ТЗ §4.12, §3-бис.2) —
 * общий для обеих частей виджета. Владелец — W1; форма зафиксирована
 * контрактом Э2 §5 (менять — через координатора).
 *
 * Граница доверия:
 *  - загрузчик принимает, только если event.origin === origin iframe И
 *    event.source === iframe.contentWindow; iframe — только если
 *    event.source === window.parent И event.origin === проверенный
 *    parentOrigin; targetOrigin — никогда не '*';
 *  - каждое сообщение `{ ns, v, type, … }`: чужие ns/v/type — игнор, поля и
 *    длины проверяются (parseParentMessage/parseFrameMessage);
 *  - НЕСИММЕТРИЧНО по данным: из iframe наружу — только размер, состояние
 *    окна и ТИП события (`V4CAssist('on')`): ни текста переписки, ни полей
 *    лида, ни токенов. Команды «отдай историю» нет;
 *  - ни одно сообщение родителя (ask/context) не исполняет действий —
 *    `ask` только кладёт вопрос в поле ввода/отправляет как вопрос посетителя.
 */
import {
  WIDGET_MESSAGE_NS,
  WIDGET_PK_LIVE_PREFIX,
  WIDGET_PK_TEST_PREFIX,
  WIDGET_PROTOCOL_VERSION,
} from './brand';
import { POSITIONS, UI_LANGS, cleanOrigin, isObj, oneOf, text } from './config';

type Obj = Record<string, unknown>;

export type WidgetPosition =
  'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';

/** Родитель (загрузчик) → iframe. */
export type ParentMessage =
  | {
      type: 'init';
      pk: string;
      /** location.origin страницы — iframe сверяет с ancestorOrigins/referrer. */
      parentOrigin: string;
      page: { url: string; title: string };
      uiLang: 'uk' | 'ru' | 'en' | null;
      mode: 'float' | 'inline';
      /** Вычисленный font-family body страницы — для шрифта «как на сайте». */
      siteFont: string | null;
      /** data-theme на <html> страницы (тема «как на сайте»). */
      siteTheme: 'light' | 'dark' | null;
      /** Одноразовый токен `?v4c_preview=` — iframe обменяет его сам. */
      previewToken: string | null;
      /** Окно было открыто на прошлой странице (sessionStorage страницы). */
      restoreOpen: boolean;
    }
  | { type: 'open' }
  | { type: 'close' }
  | { type: 'ask'; question: string }
  | { type: 'context'; data: Record<string, string | number> }
  | { type: 'route'; page: { url: string; title: string } }
  | {
      type: 'identify';
      name?: string;
      email?: string;
      externalId?: string;
      userHash?: string;
    }
  | { type: 'position'; position: WidgetPosition }
  /** «к Л2»: черновой вид во вкладке, только при allowClientPreview. */
  | { type: 'preview'; partialConfig: unknown };

/** iframe → родитель. */
export type FrameMessage =
  | { type: 'ready' }
  | { type: 'resize'; height: number }
  | { type: 'ui-state'; state: 'open' | 'min' | 'closed' }
  | { type: 'event'; name: 'open' | 'close' | 'lead' | 'handoff' }
  /** Чат недоступен на этом origin (origin_denied и т.п.) — загрузчик убирает кнопку. */
  | { type: 'unavailable'; code: string };

export type Envelope<T> = T & { ns: string; v: number };

export function envelope<T extends { type: string }>(m: T): Envelope<T> {
  return { ...m, ns: WIDGET_MESSAGE_NS, v: WIDGET_PROTOCOL_VERSION };
}

const PK_RE = new RegExp(
  `^(?:${WIDGET_PK_LIVE_PREFIX}|${WIDGET_PK_TEST_PREFIX})[A-Za-z0-9_-]{8,64}$`
);
const TOKEN_RE = /^[A-Za-z0-9_.~-]{8,256}$/;
const FONT_RE = /^[\w\s,"'.-]{1,200}$/;
const CONTEXT_KEY_RE = /^[A-Za-z0-9_.-]{1,40}$/;
export const MAX_QUESTION = 600;
export const MAX_CONTEXT_JSON = 500;
const MAX_PREVIEW_JSON = 4096;

export function isPk(v: unknown): v is string {
  return typeof v === 'string' && PK_RE.test(v);
}

function envelopeType(data: unknown): Obj | null {
  if (!isObj(data)) return null;
  if (data.ns !== WIDGET_MESSAGE_NS || data.v !== WIDGET_PROTOCOL_VERSION)
    return null;
  return typeof data.type === 'string' ? data : null;
}

/** URL страницы: только http(s), без фрагмента, ≤ 2000. */
export function pageUrl(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 2000) return null;
  try {
    const u = new URL(v);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    u.hash = '';
    return u.href;
  } catch {
    return null;
  }
}

function page(v: unknown): { url: string; title: string } | null {
  if (!isObj(v)) return null;
  const url = pageUrl(v.url);
  if (!url) return null;
  return { url, title: text(v.title, 200) ?? '' };
}

/** `V4CAssist('context')`: только строки/числа, ≤ 20 ключей, JSON ≤ 500 символов (§3-бис.2). */
export function cleanContext(
  v: unknown
): Record<string, string | number> | null {
  if (!isObj(v)) return null;
  const out: Record<string, string | number> = {};
  let n = 0;
  for (const k of Object.keys(v)) {
    if (++n > 20) return null;
    const val = v[k];
    if (!CONTEXT_KEY_RE.test(k)) return null;
    if (typeof val === 'number' && isFinite(val)) out[k] = val;
    else if (typeof val === 'string') out[k] = text(val, 200) ?? '';
    else return null;
  }
  return JSON.stringify(out).length <= MAX_CONTEXT_JSON ? out : null;
}

/** `V4CAssist('identify')`: Э2 — только предзаполнение формы лида в памяти iframe. */
export function cleanIdentify(
  v: unknown
): Extract<ParentMessage, { type: 'identify' }> | null {
  if (!isObj(v)) return null;
  const out: Extract<ParentMessage, { type: 'identify' }> = {
    type: 'identify',
  };
  for (const k of ['name', 'email', 'externalId', 'userHash'] as const) {
    if (v[k] === undefined) continue;
    const t = text(v[k], 200);
    if (t === null) return null;
    out[k] = t;
  }
  return out;
}

export function cleanQuestion(v: unknown): string | null {
  const q = text(v, MAX_QUESTION + 1);
  if (q === null) return null;
  const t = q.trim();
  return t && t.length <= MAX_QUESTION ? t : null;
}

/** Строгий разбор сообщения родителя; null — игнорировать. */
export function parseParentMessage(data: unknown): ParentMessage | null {
  const m = envelopeType(data);
  if (!m) return null;
  switch (m.type) {
    case 'init': {
      const parentOrigin = cleanOrigin(m.parentOrigin);
      const pg = page(m.page);
      if (!isPk(m.pk) || !parentOrigin || !pg) return null;
      const siteFont =
        typeof m.siteFont === 'string' && FONT_RE.test(m.siteFont)
          ? m.siteFont
          : null;
      const previewToken =
        typeof m.previewToken === 'string' && TOKEN_RE.test(m.previewToken)
          ? m.previewToken
          : null;
      return {
        type: 'init',
        pk: m.pk,
        parentOrigin,
        page: pg,
        uiLang: m.uiLang === null ? null : oneOf(UI_LANGS, m.uiLang, 'uk'),
        mode: m.mode === 'inline' ? 'inline' : 'float',
        siteFont,
        siteTheme:
          m.siteTheme === 'light' || m.siteTheme === 'dark'
            ? m.siteTheme
            : null,
        previewToken,
        restoreOpen: m.restoreOpen === true,
      };
    }
    case 'open':
    case 'close':
      return { type: m.type };
    case 'ask': {
      const question = cleanQuestion(m.question);
      return question ? { type: 'ask', question } : null;
    }
    case 'context': {
      const data = cleanContext(m.data);
      return data ? { type: 'context', data } : null;
    }
    case 'route': {
      const pg = page(m.page);
      return pg ? { type: 'route', page: pg } : null;
    }
    case 'identify':
      return cleanIdentify(m);
    case 'position':
      return (POSITIONS as readonly unknown[]).includes(m.position)
        ? { type: 'position', position: m.position as WidgetPosition }
        : null;
    case 'preview': {
      if (!isObj(m.partialConfig)) return null;
      let size = 0;
      try {
        size = JSON.stringify(m.partialConfig).length;
      } catch {
        return null;
      }
      return size <= MAX_PREVIEW_JSON
        ? { type: 'preview', partialConfig: m.partialConfig }
        : null;
    }
    default:
      return null;
  }
}

/** Строгий разбор сообщения iframe; null — игнорировать. */
export function parseFrameMessage(data: unknown): FrameMessage | null {
  const m = envelopeType(data);
  if (!m) return null;
  switch (m.type) {
    case 'ready':
      return { type: 'ready' };
    case 'resize':
      return typeof m.height === 'number' &&
        Number.isInteger(m.height) &&
        m.height >= 0 &&
        m.height <= 4000
        ? { type: 'resize', height: m.height }
        : null;
    case 'ui-state':
      return m.state === 'open' || m.state === 'min' || m.state === 'closed'
        ? { type: 'ui-state', state: m.state }
        : null;
    case 'event':
      return m.name === 'open' ||
        m.name === 'close' ||
        m.name === 'lead' ||
        m.name === 'handoff'
        ? { type: 'event', name: m.name }
        : null;
    case 'unavailable':
      return typeof m.code === 'string' && /^[A-Za-z_]{1,40}$/.test(m.code)
        ? { type: 'unavailable', code: m.code }
        : null;
    default:
      return null;
  }
}
