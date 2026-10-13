/**
 * Атрибуция на стороне сайта (проектный документ §13.5; ТЗ §14; тест —
 * `scripts/attribution.test.ts`). Чистые функции + обращения к
 * `sessionStorage`, обёрнутые в try/catch (приватный режим, запрет
 * хранилища — форма и события работают дальше, просто без `sessionRef`).
 *
 *  - `analyticsStorage='session'`: `sessionStorage[pub_sref] =
 *    {sessionRef, firstTouch:{utm, placementCode, landedAt, landingPath}}`
 *    создаётся на первой странице вкладки; внутренние переходы источник НЕ
 *    перезаписывают; события и форма шлют `sessionRef` (AT-F11-01).
 *  - `analyticsStorage='none'`: ничего не хранится (прежняя запись
 *    удаляется), `sessionRef` не отправляется, UTM текущей страницы — только
 *    в событии этой страницы; заявка после внутреннего перехода получает у
 *    сервера `unknown` (AT-F11-02).
 * Нет fingerprinting, cookie и сторонней аналитики.
 */
import { PUBLISHER_SESSION_STORAGE_KEY } from '@/brand';

export type AnalyticsStorage = 'none' | 'session';
export type Utm = Partial<Record<'source' | 'medium' | 'campaign' | 'content', string>>;

export interface FirstTouch {
  utm: Utm | null;
  placementCode: string | null;
  landedAt: string;
  landingPath: string;
}
export interface StoredSession {
  sessionRef: string;
  firstTouch: FirstTouch;
}
export interface Attribution {
  sessionRef?: string;
  utm?: Utm;
  placementCode?: string;
}

const UTM_KEYS = ['source', 'medium', 'campaign', 'content'] as const;
export const SESSION_REF_RE = /^[A-Za-z0-9_-]{8,100}$/;
/** Тот же формат, что `contracts/lead-validation.ts` (`PLACEMENT_RE`). */
export const PLACEMENT_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** Параметр адреса с кодом размещения (`?placement=`); сервер также читает `utm_content`. */
export const PLACEMENT_PARAM = 'placement';

/**
 * Похоже на контакт (защита глубже серверной `cleanUtm`, ТЗ §14/§21
 * «контакты в метки не включаются»): `@` или 7+ цифр подряд с
 * разделителями. Такие метки сайт не хранит и не отправляет.
 */
export function looksLikeContact(v: string): boolean {
  const s = v.normalize('NFKC');
  return s.includes('@') || /\d(?:[\s().+-]*\d){6,}/.test(s);
}

/** `utm_*` из строки запроса: четыре ключа, обрезка, ≤ 100 символов, без похожих на контакт (чистит и сервер). */
export function utmFromSearch(search: string): Utm | null {
  const params = new URLSearchParams(search);
  const out: Utm = {};
  for (const k of UTM_KEYS) {
    const v = params.get(`utm_${k}`)?.trim();
    if (v && !looksLikeContact(v)) out[k] = [...v].slice(0, 100).join('');
  }
  return Object.keys(out).length ? out : null;
}

/** Путь для события: только известные маршруты сайта, остальное — `/404` (в пути может оказаться ПД). */
export function eventPathOf(pathname: string): string {
  const p = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return /^\/(?:materials(?:\/[a-z0-9-]{3,80})?|contact|privacy)?$/.test(p) ? p || '/' : '/404';
}

export function placementFromSearch(search: string): string | null {
  const v = new URLSearchParams(search).get(PLACEMENT_PARAM)?.trim().toLowerCase();
  return v && PLACEMENT_RE.test(v) ? v : null;
}

/** 16 случайных байт → base64url (22 символа). */
export function newSessionRef(bytes?: Uint8Array): string {
  bytes ??= crypto.getRandomValues(new Uint8Array(16));
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function safeSessionStorage(): StorageLike | null {
  try {
    return typeof window !== 'undefined' ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

export function readSession(storage: StorageLike | null): StoredSession | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(PUBLISHER_SESSION_STORAGE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as StoredSession;
    if (!v || typeof v.sessionRef !== 'string' || !SESSION_REF_RE.test(v.sessionRef) || !v.firstTouch) return null;
    return v;
  } catch {
    return null;
  }
}

export interface Location {
  pathname: string;
  search: string;
}

/**
 * Атрибуция для события страницы. В режиме `session` создаёт запись на
 * первой странице вкладки и больше её не трогает.
 */
export function pageAttribution(
  mode: AnalyticsStorage,
  storage: StorageLike | null,
  loc: Location,
  now: Date = new Date(),
): Attribution {
  const utm = utmFromSearch(loc.search);
  const placementCode = placementFromSearch(loc.search);
  const out: Attribution = {};
  if (utm) out.utm = utm;
  if (placementCode) out.placementCode = placementCode;
  if (mode !== 'session') {
    try {
      storage?.removeItem(PUBLISHER_SESSION_STORAGE_KEY);
    } catch {
      /* хранилище недоступно — и хранить нечего */
    }
    return out;
  }
  let session = readSession(storage);
  if (!session) {
    session = {
      sessionRef: newSessionRef(),
      firstTouch: { utm, placementCode, landedAt: now.toISOString(), landingPath: eventPathOf(loc.pathname) },
    };
    try {
      storage?.setItem(PUBLISHER_SESSION_STORAGE_KEY, JSON.stringify(session));
    } catch {
      return out; // не сохранить — не выдумывать сессию, которой не будет у формы
    }
    if (!storage) return out;
  }
  out.sessionRef = session.sessionRef;
  return out;
}

/** Хост перехода — только чужой и только хост (без пути). */
export function referrerHostOf(referrer: string, ownHost: string): string | undefined {
  if (!referrer) return undefined;
  try {
    const u = new URL(referrer);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined;
    const h = u.host.toLowerCase();
    return h && h !== ownHost.toLowerCase() ? h : undefined;
  } catch {
    return undefined;
  }
}

/** `slug` материала из пути `/materials/<slug>`. */
export function contentSlugOf(pathname: string): string | undefined {
  const m = /^\/materials\/([a-z0-9-]{3,80})\/?$/.exec(pathname);
  return m ? m[1] : undefined;
}
