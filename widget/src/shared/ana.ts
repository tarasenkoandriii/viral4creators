/**
 * Э3-бис: связанный режим — чистые части чанка ana.js (тесты —
 * scripts/ana.test.ts): разбор поля `analytics` конфига, назначение группы
 * эксперимента (FNV-1a 32 — тот же код, что сервер:
 * sites-backend/src/modules/assist-analytics/exp/experiment-math.ts),
 * сигналы «не отслеживать» и Google Consent Mode.
 */
import { isObj } from './config';

export type AnaLang = 'uk' | 'ru' | 'en';

export interface AnaExperiment {
  id: string;
  kind: 'holdout' | 'greeting' | 'suggestions';
  share: number;
  salt: string;
  greeting: Partial<Record<AnaLang, string>> | null;
  suggestions: Partial<Record<AnaLang, string[]>> | null;
}

export interface AnaConfig {
  gcm: boolean;
  behavior: boolean;
  exp: AnaExperiment | null;
}

const ID = /^[A-Za-z0-9_-]{1,40}$/;

function langs<T>(
  v: unknown,
  ok: (x: unknown) => x is T
): Partial<Record<AnaLang, T>> | null {
  if (!isObj(v)) return null;
  const out: Partial<Record<AnaLang, T>> = {};
  for (const l of ['uk', 'ru', 'en'] as const) if (ok(v[l])) out[l] = v[l] as T;
  return Object.keys(out).length ? out : null;
}
const isText = (x: unknown): x is string =>
  typeof x == 'string' && x.length > 0 && x.length <= 300;
const isList = (x: unknown): x is string[] =>
  Array.isArray(x) &&
  x.length > 0 &&
  x.length <= 4 &&
  x.every((y) => typeof y == 'string' && y.length > 0 && y.length <= 80);

/** Строгий разбор `analytics` конфига; null — связанного режима нет. */
export function parseAna(raw: unknown): AnaConfig | null {
  if (!isObj(raw) || !isObj(raw.consent)) return null;
  let exp: AnaExperiment | null = null;
  const e = raw.experiment;
  if (
    isObj(e) &&
    typeof e.id == 'string' &&
    ID.test(e.id) &&
    (e.kind == 'holdout' || e.kind == 'greeting' || e.kind == 'suggestions') &&
    typeof e.share == 'number' &&
    e.share > 0 &&
    e.share < 1 &&
    typeof e.salt == 'string' &&
    ID.test(e.salt)
  )
    exp = {
      id: e.id,
      kind: e.kind as AnaExperiment['kind'],
      share: e.share,
      salt: e.salt,
      greeting: e.kind == 'greeting' ? langs(e.variant, isText) : null,
      suggestions: e.kind == 'suggestions' ? langs(e.variant, isList) : null,
    };
  return {
    gcm: raw.consent.gcm === true,
    behavior: raw.behavior === true,
    exp,
  };
}

/** FNV-1a 32 бит (UTF-16 коды) — как у сервера. */
export function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Группа: b — вариант B (у holdout — без виджета). */
export function armOf(salt: string, visit: string, share: number): 'a' | 'b' {
  return fnv1a32(salt + ':' + visit) / 4294967296 < share ? 'b' : 'a';
}

/** GPC/DNT: «не отслеживать» — режим «без согласия» всегда (В-46). */
export function doNotTrack(
  nav: Partial<{ globalPrivacyControl: unknown; doNotTrack: unknown }>,
  win: Partial<{ doNotTrack: unknown }>
): boolean {
  return (
    nav.globalPrivacyControl === true ||
    nav.doNotTrack === '1' ||
    nav.doNotTrack === 'yes' ||
    win.doNotTrack === '1'
  );
}

/**
 * Последнее решение Google Consent Mode v2 об `analytics_storage` в
 * dataLayer (`gtag('consent', 'default'|'update', {...})` кладёт туда
 * объект arguments): true/false или null — решения нет.
 */
export function gcmAnalytics(dataLayer: unknown): boolean | null {
  if (!Array.isArray(dataLayer)) return null;
  let r: boolean | null = null;
  for (const e of dataLayer) {
    const a = e as { 0?: unknown; 1?: unknown; 2?: unknown } | null;
    if (
      a &&
      typeof a == 'object' &&
      a[0] == 'consent' &&
      (a[1] == 'default' || a[1] == 'update') &&
      isObj(a[2]) &&
      typeof a[2].analytics_storage == 'string'
    )
      r = a[2].analytics_storage == 'granted';
  }
  return r;
}

/**
 * Вклад сдвига вёрстки в CLS (без сдвигов сразу после ввода) — здесь, а не
 * в bf.js: там чтение `.value` запрещено линтером (К-11), а у записи
 * `layout-shift` поле так и называется.
 */
export function shiftOf(e: PerformanceEntry): number {
  const s = e as PerformanceEntry & {
    value?: number;
    hadRecentInput?: boolean;
  };
  return s.hadRecentInput || typeof s.value != 'number' ? 0 : s.value;
}
