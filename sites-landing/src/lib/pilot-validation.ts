/**
 * Заявка в пилот: нормализация и проверка (ТЗ лендинга §3.11, §14 Л1).
 *
 * Чистый модуль без секретов и без Node-API: им пользуются и форма в
 * браузере (подсказки до отправки), и route handler (окончательная
 * проверка — сервер не верит клиенту). Токен бота и chat id живут
 * только в `src/server/` — туда клиентский код не импортирует (держит
 * `scripts/pilot.test.ts` и проверка бандла в `scripts/built/check-built.ts`).
 */

export const PILOT_SEGMENTS = ['ecommerce', 'saas', 'services', 'agency', 'other'] as const;
export type PilotSegment = (typeof PILOT_SEGMENTS)[number];

export type PilotField = 'name' | 'contact' | 'site' | 'segment' | 'message' | 'consent';

/** Имя поля-ловушки: настоящий человек его не видит и не заполняет. */
export const HONEYPOT_FIELD = 'hp_extra_info';

export const PILOT_LIMITS = {
  name: 100,
  contact: 120,
  site: 200,
  message: 1000,
  /** Тело запроса целиком — с запасом на кодирование формы. */
  bodyBytes: 10_000,
} as const;

export interface PilotApplication {
  name: string;
  contact: string;
  contactKind: 'email' | 'telegram';
  site: string;
  segment: PilotSegment;
  message: string;
  locale: string;
}

export type PilotValidation =
  | { ok: true; value: PilotApplication; honeypot: boolean }
  | { ok: false; errors: PilotField[]; honeypot: boolean };

// Управляющие символы (кроме перевода строки и таба в сообщении) — вон.
// Пишется через RegExp-конструктор, чтобы в исходнике не было литеральных
// управляющих символов (eslint no-control-regex).
const CONTROL = new RegExp('[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F\\u202A-\\u202E\\u2066-\\u2069]', 'g');

function clean(value: unknown, multiline = false): string {
  if (typeof value !== 'string') return '';
  let s = value.replace(CONTROL, '');
  s = multiline ? s.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n') : s.replace(/\s+/g, ' ');
  return s.trim();
}

const EMAIL = /^[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[A-Za-z]{2,}$/;
const TELEGRAM = /^@([A-Za-z][A-Za-z0-9_]{4,31})$/;

export function normalizeContact(raw: string): { value: string; kind: 'email' | 'telegram' } | null {
  const s = raw.trim();
  if (!s || s.length > PILOT_LIMITS.contact) return null;
  if (EMAIL.test(s)) return { value: s, kind: 'email' };
  const tme = /^(?:https?:\/\/)?t\.me\/([A-Za-z][A-Za-z0-9_]{4,31})\/?$/i.exec(s);
  const tg = tme ? [s, tme[1]] : TELEGRAM.exec(s);
  if (tg) return { value: `@${tg[1]}`, kind: 'telegram' };
  return null;
}

export function normalizeSite(raw: string): string | null {
  const s = raw.trim();
  if (!s || s.length > PILOT_LIMITS.site) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password) return null;
  const host = url.hostname;
  if (!host.includes('.') || host.startsWith('.') || host.endsWith('.')) return null;
  return url.toString();
}

function truthy(v: unknown): boolean {
  return v === true || v === 'on' || v === 'true' || v === '1' || v === 'yes';
}

export function validatePilot(raw: Record<string, unknown>): PilotValidation {
  const honeypot = clean(raw[HONEYPOT_FIELD]).length > 0;
  const errors: PilotField[] = [];

  const name = clean(raw.name);
  if (!name || name.length > PILOT_LIMITS.name) errors.push('name');

  const contact = normalizeContact(clean(raw.contact));
  if (!contact) errors.push('contact');

  const site = normalizeSite(clean(raw.site));
  if (!site) errors.push('site');

  const segmentRaw = clean(raw.segment);
  const segment = (PILOT_SEGMENTS as readonly string[]).includes(segmentRaw) ? (segmentRaw as PilotSegment) : null;
  if (!segment) errors.push('segment');

  const message = clean(raw.message, true);
  if (message.length > PILOT_LIMITS.message) errors.push('message');

  if (!truthy(raw.consent)) errors.push('consent');

  const locale = ['uk', 'en', 'ru'].includes(clean(raw.locale)) ? clean(raw.locale) : 'en';

  if (errors.length > 0 || !contact || !site || !segment) return { ok: false, errors, honeypot };
  return {
    ok: true,
    honeypot,
    value: { name, contact: contact.value, contactKind: contact.kind, site, segment, message, locale },
  };
}

/** Коды ответа route handler'а — их же показывает форма. */
export type PilotResultCode = 'sent' | 'invalid' | 'limited' | 'unavailable' | 'error';
export const PILOT_RESULT_CODES: readonly PilotResultCode[] = ['sent', 'invalid', 'limited', 'unavailable', 'error'];
