/**
 * Итог просмотра страницы из чанка `bf.js` (Э3-бис; ТЗ §5-тер.8, К-11,
 * Р-46) — ЧИСТЫЙ модуль: строгий белый список полей (неизвестное поле —
 * отказ целиком: вторая линия К-11 после линтера чанка), нормализация пути
 * и источника, без отпечатка.
 *
 * Чего здесь не может быть по построению: значений полей, их длины, нажатий
 * клавиш, координат, строки User-Agent, разрешения экрана, часового пояса,
 * click-id рекламы (gclid/fbclid/…), полного URL реферера.
 */
import { maskSensitiveEcho } from '../../../shared/assist-chat-core/post-filter';

export interface PageViewInput {
  pk: string;
  pv: string;
  /** Ключ визита (только с согласием — без него поведение не принимается). */
  v: string;
  path: string;
  prevPath: string | null;
  refHost: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  device: 'mobile' | 'tablet' | 'desktop';
  scrollMax: number;
  activeMs: number;
  totalMs: number;
  clicks: number;
  rageClicks: number;
  jsErrors: number;
  errorGroups: Array<{ h: string; m: string; s: string | null }>;
  formStarted: boolean;
  formSubmitted: boolean;
  formAbandonField: string | null;
  formInvalid: number;
  backNav: boolean;
  lcpMs: number | null;
  inpMs: number | null;
  cls: number | null;
  chatOpened: boolean;
}

/** Короткие ключи тела (чанк ≤ 4 КБ gzip) → поля. */
export const PAGE_VIEW_KEYS = [
  'pk',
  'pv',
  'v',
  'p',
  'pp',
  'rh',
  'us',
  'um',
  'uc',
  'd',
  'sc',
  'ac',
  'to',
  'ck',
  'rg',
  'er',
  'eg',
  'fs',
  'fb',
  'fa',
  'fi',
  'bk',
  'l',
  'i',
  'c',
  'ch',
] as const;

const PV_ID = /^[A-Za-z0-9_-]{12,40}$/;
const VISIT = /^[A-Za-z0-9_-]{16,64}$/;
const HOST = /^[a-z0-9.-]{1,100}$/;
const FIELD = /^[A-Za-z0-9_.:[\]-]{1,30}$/;
const HASH = /^[0-9a-f]{1,16}$/;
const UTM = /^[\p{L}\p{N} _.,:/+-]{1,60}$/u;
const MAX_MS = 30 * 60 * 1000;

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
const int = (v: unknown, min: number, max: number): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max
    ? Math.round(v)
    : null;
const bit = (v: unknown): boolean | null =>
  v === 0 || v === 1 || v === true || v === false
    ? v === 1 || v === true
    : null;

/**
 * Сегмент пути похож на ПД (аудит Э3-бис): e-mail (в т.ч. `%40`) или ≥ 6
 * цифр — телефон, номер заказа/клиента (`order-1234567`, `+38(050)…`).
 * Такой путь уходит в отчёты и во вход модели — вместо сегмента `:id`.
 */
export function piiSegment(s: string): boolean {
  let d = s;
  try {
    d = decodeURIComponent(s);
  } catch {
    d = s;
  }
  return /@/.test(d) || (d.match(/\d/g)?.length ?? 0) >= 6;
}

/** Путь: без query/hash; цифры, UUID, хеши, ПД-сегменты → `:id`; ≤ 200. */
export function normalizePath(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.length > 1000) {
    return null;
  }
  const p = raw.replace(/[?#].*$/, '');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\s]/.test(p)) return null;
  const segs = p
    .split('/')
    .map((s) =>
      /^\d+$/.test(s) ||
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        s,
      ) ||
      /^[0-9a-f]{12,}$/i.test(s) ||
      /^[A-Za-z0-9_-]{24,}$/.test(s) ||
      piiSegment(s)
        ? ':id'
        : s,
    );
  const out = segs.join('/').slice(0, 200);
  return out || '/';
}

function utm(v: unknown): string | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string') return null;
  const t = maskSensitiveEcho(v.trim().toLowerCase()).slice(0, 60);
  return UTM.test(t) ? t : null;
}

/** Строгий разбор: null — отказ (400). */
export function parsePageView(raw: unknown): PageViewInput | null {
  if (!isObj(raw)) return null;
  for (const k of Object.keys(raw)) {
    if (!(PAGE_VIEW_KEYS as readonly string[]).includes(k)) return null;
  }
  const { pk, pv, v } = raw;
  if (typeof pk !== 'string' || pk.length > 80) return null;
  if (typeof pv !== 'string' || !PV_ID.test(pv)) return null;
  if (typeof v !== 'string' || !VISIT.test(v)) return null;
  const path = normalizePath(raw.p);
  if (!path) return null;
  const prevPath = raw.pp === undefined ? null : normalizePath(raw.pp);
  const rh =
    raw.rh === undefined || raw.rh === ''
      ? null
      : typeof raw.rh === 'string' && HOST.test(raw.rh.toLowerCase())
        ? raw.rh.toLowerCase()
        : undefined;
  if (rh === undefined) return null;
  const device =
    raw.d === 'm'
      ? 'mobile'
      : raw.d === 't'
        ? 'tablet'
        : raw.d === 'd'
          ? 'desktop'
          : null;
  if (!device) return null;
  const nums = {
    scrollMax: int(raw.sc ?? 0, 0, 100),
    activeMs: int(raw.ac ?? 0, 0, MAX_MS),
    totalMs: int(raw.to ?? 0, 0, 24 * 60 * 60 * 1000),
    clicks: int(raw.ck ?? 0, 0, 10_000),
    rageClicks: int(raw.rg ?? 0, 0, 1_000),
    jsErrors: int(raw.er ?? 0, 0, 1_000),
    formInvalid: int(raw.fi ?? 0, 0, 1_000),
  };
  if (Object.values(nums).some((x) => x === null)) return null;
  const errorGroups: PageViewInput['errorGroups'] = [];
  if (raw.eg !== undefined) {
    if (!Array.isArray(raw.eg) || raw.eg.length > 3) return null;
    for (const g of raw.eg) {
      if (
        !isObj(g) ||
        Object.keys(g).some((k) => !['h', 'm', 's'].includes(k))
      ) {
        return null;
      }
      if (typeof g.h !== 'string' || !HASH.test(g.h)) return null;
      const m =
        typeof g.m === 'string' ? maskSensitiveEcho(g.m).slice(0, 120) : '';
      const s =
        typeof g.s === 'string' && HOST.test(g.s.toLowerCase())
          ? g.s.toLowerCase()
          : null;
      errorGroups.push({ h: g.h, m, s });
    }
  }
  const flags = {
    fs: bit(raw.fs ?? 0),
    fb: bit(raw.fb ?? 0),
    bk: bit(raw.bk ?? 0),
    ch: bit(raw.ch ?? 0),
  };
  if (Object.values(flags).some((x) => x === null)) return null;
  const fa =
    raw.fa === undefined || raw.fa === ''
      ? null
      : typeof raw.fa === 'string' && FIELD.test(raw.fa)
        ? raw.fa
        : undefined;
  if (fa === undefined) return null;
  const lcp = raw.l === undefined ? null : int(raw.l, 0, 120_000);
  const inp = raw.i === undefined ? null : int(raw.i, 0, 60_000);
  const cls =
    raw.c === undefined
      ? null
      : typeof raw.c === 'number' && raw.c >= 0 && raw.c <= 100
        ? Math.round(raw.c * 1000) / 1000
        : undefined;
  if (
    (raw.l !== undefined && lcp === null) ||
    (raw.i !== undefined && inp === null) ||
    cls === undefined
  ) {
    return null;
  }
  return {
    pk,
    pv,
    v,
    path,
    prevPath,
    refHost: rh,
    utmSource: utm(raw.us),
    utmMedium: utm(raw.um),
    utmCampaign: utm(raw.uc),
    device,
    scrollMax: nums.scrollMax as number,
    activeMs: nums.activeMs as number,
    totalMs: nums.totalMs as number,
    clicks: nums.clicks as number,
    rageClicks: nums.rageClicks as number,
    jsErrors: nums.jsErrors as number,
    errorGroups,
    formStarted: flags.fs as boolean,
    formSubmitted: flags.fb as boolean,
    formAbandonField: (flags.fb as boolean) ? null : fa,
    formInvalid: nums.formInvalid as number,
    backNav: flags.bk as boolean,
    lcpMs: lcp,
    inpMs: inp,
    cls,
    chatOpened: flags.ch as boolean,
  };
}

const SEARCH =
  /(^|\.)(google|bing|duckduckgo|yahoo|ecosia|yandex|baidu|startpage|qwant)\./;
const SOCIAL =
  /(^|\.)(facebook|instagram|twitter|x|linkedin|tiktok|youtube|pinterest|reddit|threads)\.(com|net)$|^t\.co$|(^|\.)fb\.me$/;
const MESSENGER =
  /^(t\.me|telegram\.me|telegram\.org|wa\.me|m\.me)$|(^|\.)(viber|whatsapp|messenger)\.com$/;
const MAIL =
  /(^|\.)(mail|outlook|gmail|ukr|meta|i)\.(com|net|ua|live)$|^mail\./;

/** Категория источника (§5-тер.8 «Откуда»); хост реферера своего сайта — direct. */
export function sourceCategory(
  refHost: string | null,
  utmMedium: string | null,
  ownHost: string | null,
): 'direct' | 'search' | 'social' | 'ads' | 'messenger' | 'link' | 'email' {
  if (
    utmMedium &&
    /^(cpc|ppc|paid|ads?|display|cpm|paidsocial|paid_social)$/.test(utmMedium)
  ) {
    return 'ads';
  }
  if (utmMedium === 'email' || utmMedium === 'newsletter') return 'email';
  if (!refHost || (ownHost && refHost === ownHost)) return 'direct';
  if (SEARCH.test(refHost)) return 'search';
  if (MESSENGER.test(refHost)) return 'messenger';
  if (SOCIAL.test(refHost)) return 'social';
  if (MAIL.test(refHost)) return 'email';
  return 'link';
}

/** Семейство ОС и браузера из UA — без версий (сам UA не хранится). */
export function uaFamily(ua: string | undefined): {
  os: string;
  browser: string;
} {
  const s = ua ?? '';
  const os = /Android/i.test(s)
    ? 'android'
    : /iPhone|iPad|iPod/i.test(s)
      ? 'ios'
      : /Windows/i.test(s)
        ? 'windows'
        : /Mac OS X|Macintosh/i.test(s)
          ? 'macos'
          : /Linux|CrOS/i.test(s)
            ? 'linux'
            : 'other';
  const browser = /Edg\//.test(s)
    ? 'edge'
    : /OPR\/|Opera/.test(s)
      ? 'opera'
      : /SamsungBrowser/.test(s)
        ? 'samsung'
        : /Firefox\/|FxiOS/.test(s)
          ? 'firefox'
          : /Chrome\/|CriOS/.test(s)
            ? 'chrome'
            : /Safari\//.test(s)
              ? 'safari'
              : 'other';
  return { os, browser };
}

/** Исключённые по умолчанию пути (личные кабинеты, админка — §5-тер.8). */
export const DEFAULT_EXCLUDED_BEHAVIOR_PATHS = [
  '/account*',
  '/cabinet*',
  '/profile*',
  '/my*',
  '/admin*',
  '/wp-admin*',
];
