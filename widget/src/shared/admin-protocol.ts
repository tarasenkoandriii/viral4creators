/**
 * Протокол postMessage «Админки» (Э7, ТЗ §4.12, §4-бис.8): чанк `admin.js`
 * на странице админки заказчика ↔ iframe чата сотрудника на ОТДЕЛЬНОМ
 * origin `wa.` (У-13). Свой ns (`v4c-admin`) — сообщения публичного
 * виджета (`v4c-widget`) этот протокол не принимает и наоборот (У-18).
 *
 * Граница доверия та же, что у виджета: принимается только
 * `event.source === iframe.contentWindow` и `event.origin === origin wa.`
 * (родитель) / `event.source === window.parent` и проверенный origin
 * родителя (iframe); targetOrigin — никогда не '*'.
 *
 * Несимметрично по данным: родитель → iframe — `init` (pk, origin
 * родителя, язык), `identity` (свежий employee-JWT от бэкенда заказчика),
 * `logout`; iframe → родитель — только `ready`, `need-identity`, `close`.
 * Переписка, сессия сотрудника и его `sub` из iframe наружу не уходят.
 */
import {
  ADMIN_MESSAGE_NS,
  WIDGET_PK_LIVE_PREFIX,
  WIDGET_PK_TEST_PREFIX,
} from './brand';

export const ADMIN_PROTOCOL_VERSION = 1;

export type AdminParentMessage =
  | {
      type: 'init';
      pk: string;
      parentOrigin: string;
      lang: 'uk' | 'ru' | 'en' | null;
      /** Э6-бис (б): токен ссылки мастера проверки (`?v4c_voicetest=`). */
      vt?: string | null;
    }
  | { type: 'identity'; jwt: string }
  | { type: 'logout' }
  /**
   * Э6-бис (б): голосовое управление — ответы чанка `admin-act.js` со
   * страницы (снимок, итоги шагов, стоп человеком, регистратор мастера).
   * Сырой объект: строго его разбирает чанк `admin-vc.js` iframe.
   */
  | { type: 'ui'; raw: Record<string, unknown> };

export type AdminFrameMessage =
  | { type: 'ready' }
  | { type: 'need-identity' }
  | { type: 'close' }
  /**
   * Э6-бис (б): команды плана iframe → страница (снимок, шаги, стоп,
   * пауза, возврат полей, проверки мастера). `admin.js` только узнаёт вид
   * и отдаёт сырое `admin-act.js` — разбор строгий там (`parseUiCommand`).
   */
  | { type: 'ui-raw'; raw: Record<string, unknown> };

/** Виды команд плана iframe → страница (Э6-бис (б)). */
const UI_TO_PAGE = [
  'ui-snap',
  'ui-run',
  'ui-ack',
  'ui-stop',
  'ui-pause',
  'ui-undo',
  'vt-env',
  'vt-markup',
  'vt-mark',
  'vt-arm',
];
/** Виды ответов страницы → iframe (Э6-бис (б)). */
const UI_TO_FRAME = [
  'ui-snapshot',
  'ui-step',
  'ui-need',
  'ui-stopped',
  'ui-undone',
  'ui-attempt',
  'vt-result',
  'vt-submit',
];
const VT_TOKEN = /^[A-Za-z0-9_-]{20,100}$/;

const JWT =
  /^[A-Za-z0-9_-]{2,1000}\.[A-Za-z0-9_-]{2,3000}\.[A-Za-z0-9_-]{2,200}$/;
const ORIGIN = /^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/;

export function isAdminPk(v: unknown): v is string {
  return (
    typeof v === 'string' &&
    v.length <= 80 &&
    (v.indexOf(WIDGET_PK_LIVE_PREFIX) === 0 ||
      v.indexOf(WIDGET_PK_TEST_PREFIX) === 0) &&
    /^[A-Za-z0-9_]+$/.test(v)
  );
}

export function isJwt(v: unknown): v is string {
  return typeof v === 'string' && v.length <= 4096 && JWT.test(v);
}

export function adminEnvelope<T extends object>(
  m: T
): T & { ns: string; v: number } {
  return { ns: ADMIN_MESSAGE_NS, v: ADMIN_PROTOCOL_VERSION, ...m };
}

function base(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  return o.ns === ADMIN_MESSAGE_NS && o.v === ADMIN_PROTOCOL_VERSION ? o : null;
}

export function parseAdminParentMessage(
  raw: unknown
): AdminParentMessage | null {
  const o = base(raw);
  if (!o) return null;
  if (o.type === 'init') {
    if (
      !isAdminPk(o.pk) ||
      typeof o.parentOrigin !== 'string' ||
      !ORIGIN.test(o.parentOrigin)
    ) {
      return null;
    }
    const lang =
      o.lang === 'uk' || o.lang === 'ru' || o.lang === 'en' ? o.lang : null;
    const vt = typeof o.vt === 'string' && VT_TOKEN.test(o.vt) ? o.vt : null;
    return { type: 'init', pk: o.pk, parentOrigin: o.parentOrigin, lang, vt };
  }
  if (o.type === 'identity')
    return isJwt(o.jwt) ? { type: 'identity', jwt: o.jwt } : null;
  if (o.type === 'logout') return { type: 'logout' };
  if (typeof o.type === 'string' && UI_TO_FRAME.indexOf(o.type) >= 0)
    return { type: 'ui', raw: o };
  return null;
}

export function parseAdminFrameMessage(raw: unknown): AdminFrameMessage | null {
  const o = base(raw);
  if (!o) return null;
  if (o.type === 'ready' || o.type === 'need-identity' || o.type === 'close')
    return { type: o.type };
  return typeof o.type === 'string' && UI_TO_PAGE.indexOf(o.type) >= 0
    ? { type: 'ui-raw', raw: o }
    : null;
}

/**
 * Полезная нагрузка JWT БЕЗ проверки подписи (её делает сервер): iframe
 * читает только `sub`/`iat`/`exp` — чтобы понять «сменился ли сотрудник» и
 * когда просить свежий токен. Ошибка разбора — null.
 */
export function jwtClaims(
  jwt: string
): { sub: string; iat: number; exp: number } | null {
  try {
    const part = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = JSON.parse(
      decodeURIComponent(
        Array.prototype.map
          .call(
            atob(part),
            (c: string) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)
          )
          .join('')
      )
    ) as Record<string, unknown>;
    if (typeof json.sub !== 'string' || typeof json.exp !== 'number')
      return null;
    const iat =
      typeof json.iat === 'number' ? json.iat : Math.floor(Date.now() / 1000);
    return { sub: json.sub, iat, exp: json.exp };
  } catch {
    return null;
  }
}
