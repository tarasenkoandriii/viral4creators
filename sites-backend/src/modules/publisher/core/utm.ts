/**
 * AI Publisher — UTM (P-A1, проектный документ §11.4, §6.4; AT-CORE-09):
 *  - `cleanUtm` — очистка входящих меток публичного API: только четыре
 *    ключа (`source, medium, campaign, content`, с префиксом `utm_` или
 *    без), значение `[буквы цифры ._:/-]{1,100}`; похожее на email/телефон
 *    → `[redacted]` с флагом (`pub_events.utmRedacted`). Результат проходит
 *    триггер `pub_utm_guard`;
 *  - `buildMeasurableUrl` — измеряемая ссылка канала/закупки (P-C):
 *    https-адрес + `utm_*`; значение с контактом или вне алфавита — отказ.
 *
 * Чистый модуль (его берёт публичный код).
 */
import { UTM_KEYS, type UtmKey } from '../contracts/states';
import { looksLikeContact } from './pii-guard';

export const UTM_REDACTED = '[redacted]';
export const UTM_MAX = 100;
/** Алфавит значения — тот же, что `^[[:alnum:] ._:/-]{1,100}$` триггера. */
const UTM_VALUE_RE = /^[\p{L}\p{N} ._:/-]{1,100}$/u;
const UTM_STRIP_RE = /[^\p{L}\p{N} ._:/-]+/gu;

export type CleanUtm = Partial<Record<UtmKey, string>>;

export interface CleanUtmResult {
  /** null — ни одной метки (в базу пишется NULL, а не `{}`). */
  utm: CleanUtm | null;
  /** Хотя бы одно значение заменено на `[redacted]`. */
  redacted: boolean;
  /** Отброшенные ключи (не из списка) — для диагностики, без значений. */
  droppedKeys: string[];
}

function keyOf(raw: string): UtmKey | null {
  const k = raw.trim().toLowerCase().replace(/^utm_/, '');
  return (UTM_KEYS as readonly string[]).includes(k) ? (k as UtmKey) : null;
}

/** Одно значение: контакт → redacted; иначе — алфавит и длина. */
export function cleanUtmValue(raw: unknown): {
  value: string | null;
  redacted: boolean;
} {
  if (typeof raw !== 'string') return { value: null, redacted: false };
  // NFKC: полноширинные цифры и буквы → ASCII (то же делает pii-guard).
  const trimmed = raw.normalize('NFKC').trim();
  if (!trimmed) return { value: null, redacted: false };
  // Контакт проверяется ДО вырезания символов: «a@b.c» без «@» уже не email.
  if (looksLikeContact(trimmed)) return { value: UTM_REDACTED, redacted: true };
  const cleaned = trimmed
    .replace(UTM_STRIP_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const cut = [...cleaned].slice(0, UTM_MAX).join('').trim();
  if (!cut) return { value: null, redacted: false };
  // Вырезание могло склеить цифры в «телефон» — та же проверка ещё раз.
  if (looksLikeContact(cut)) return { value: UTM_REDACTED, redacted: true };
  return { value: cut, redacted: false };
}

export function cleanUtm(raw: unknown): CleanUtmResult {
  const out: CleanUtm = {};
  const droppedKeys: string[] = [];
  let redacted = false;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { utm: null, redacted: false, droppedKeys };
  }
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const key = keyOf(k);
    if (!key) {
      droppedKeys.push(k.slice(0, 40));
      continue;
    }
    if (out[key] !== undefined) continue; // `source` и `utm_source` — первое
    const c = cleanUtmValue(v);
    if (c.value === null) continue;
    out[key] = c.value;
    redacted = redacted || c.redacted;
  }
  return {
    utm: Object.keys(out).length ? out : null,
    redacted,
    droppedKeys,
  };
}

/** Значение метки для ссылки: алфавит, длина, без контакта. */
export function isValidUtmValue(v: string): boolean {
  return UTM_VALUE_RE.test(v) && !looksLikeContact(v);
}

export class UtmError extends Error {
  constructor(
    readonly field: string,
    readonly code: string,
  ) {
    super(`utm: ${field} — ${code}`);
    this.name = 'UtmError';
  }
}

/**
 * Измеряемая ссылка (§6.4, F09/F12): `https`-адрес назначения + метки.
 * Существующие `utm_*` адреса заменяются, прочие параметры и якорь
 * сохраняются. Пустая метка не пишется.
 */
export function buildMeasurableUrl(base: string, utm: CleanUtm): string {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new UtmError('url', 'format');
  }
  if (url.protocol !== 'https:') throw new UtmError('url', 'not_https');
  if (url.username || url.password) throw new UtmError('url', 'format');
  for (const key of UTM_KEYS) url.searchParams.delete(`utm_${key}`);
  for (const key of UTM_KEYS) {
    const v = utm[key];
    if (v === undefined || v === '') continue;
    if (!isValidUtmValue(v)) throw new UtmError(key, 'format');
    url.searchParams.set(`utm_${key}`, v);
  }
  return url.toString();
}

/** Метки из ссылки (для сверки выданной ссылки закупки с кодом размещения). */
export function utmOf(link: string): CleanUtm {
  const out: CleanUtm = {};
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return out;
  }
  for (const key of UTM_KEYS) {
    const v = url.searchParams.get(`utm_${key}`);
    if (v) out[key] = v;
  }
  return out;
}
