/* СГЕНЕРИРОВАНО publisher-site/scripts/sync-shared.mjs — не править.
 * Источник: sites-backend/src/modules/publisher/contracts/lead-validation.ts. Правка — в источнике, затем
 * `node scripts/sync-shared.mjs` (из publisher-site); CI сверяет копию --check. */
/**
 * AI Publisher — проверка тела публичной формы `POST
 * /public/publisher/v1/leads` (контракт P-A1, проектный документ §11.4,
 * §13.4; ТЗ §6). ОДНИ правила для сервера (P-D, `public/lead-intake.ts`) и
 * сайта (P-F, `publisher-site` гоняет те же векторы через этот файл —
 * `scripts/lead-validation.test.ts`), поэтому модуль САМОДОСТАТОЧЕН: без
 * импортов, без Node API.
 *
 * Обязательное — по способу связи; длины — как у шифруемых полей §6.5
 * (задача ≤ 2000). Поля атрибуции (`contentSlug`, `placementCode`,
 * `sessionRef`) — мягкие: «кривое» значение из адресной строки не роняет
 * заявку, а отбрасывается (`dropped`). Ловушка `hp` — не ошибка, а флаг:
 * сервер отвечает как при успехе без записи (аудит P3-21); `elapsedMs <
 * 800` — только пометка `suspectedSpam`.
 *
 * КОНТРАКТ ДЛЯ P-D (аудит P-A1 P3-10): `pub_leads.requestHash` (повтор
 * отправки, §6.5/§11.4) — НЕ беcключевой sha256 нормализованного тела: в
 * теле контакт и имя, колонку читает роль `publisher_public`, по дампу
 * перебор телефонов восстановил бы контакт. Считать ключевым HMAC связки
 * `contactMatch`: `leadRequestHmac(productId, canonicalJson(тело), keys)`
 * (`core/contact-crypto.ts`), поиск повтора во время ротации ключа —
 * `leadRequestHmacs` (все ключи связки).
 */

export const LEAD_BODY_MAX_BYTES = 8 * 1024;
export const LEAD_TASK_MAX = 2000;
export const LEAD_NAME_MAX = 120;
export const LEAD_BUSINESS_MAX = 300;
export const LEAD_FAST_FILL_MS = 800;

export const LEAD_CONTACT_METHODS = [
  'email',
  'phone',
  'telegram',
  'other',
] as const;
export type LeadContactMethod = (typeof LEAD_CONTACT_METHODS)[number];
export const LEAD_CONSENT_STATES = [
  'granted',
  'denied',
  'unknown',
  'not_required',
] as const;
export type LeadConsentState = (typeof LEAD_CONSENT_STATES)[number];
/** Ключи диапазона бюджета (`pub_leads.budgetRange`; соответствие параметру — обогащение). */
export const LEAD_BUDGET_RANGES = [
  'under_10k',
  '10k_30k',
  '30k_100k',
  'over_100k',
  'unknown',
] as const;
export type LeadBudgetRange = (typeof LEAD_BUDGET_RANGES)[number];
/** Категория самоотчёта «откуда узнали» (`pub_leads.selfReportedChannel`). */
export const LEAD_SELF_REPORTED_CHANNELS = [
  'search',
  'social',
  'telegram',
  'recommendation',
  'publication',
  'other',
] as const;
export type LeadSelfReportedChannel =
  (typeof LEAD_SELF_REPORTED_CHANNELS)[number];

export interface LeadFieldIssue {
  field: string;
  /** `required|type|enum|length|format` */
  code: string;
}

/** Тело формы, как его шлёт сайт. */
export interface LeadBody {
  key: string;
  submissionKey: string;
  name: string;
  contactMethod: LeadContactMethod;
  contact: string;
  business: string;
  task: string;
  budgetRange?: LeadBudgetRange;
  selfReported?: { channel: LeadSelfReportedChannel; note?: string };
  dataNoticeVersion: string;
  consentState: LeadConsentState;
  sessionRef?: string;
  contentSlug?: string;
  placementCode?: string;
  utm?: Record<string, string>;
  hp?: string;
  elapsedMs?: number;
}

/** Нормализованная заявка (контакт — в шифр, остальное — открыто). */
export interface LeadInput {
  key: string;
  submissionKey: string;
  name: string;
  contactMethod: LeadContactMethod;
  contact: string;
  business: string;
  task: string;
  budgetRange: LeadBudgetRange | null;
  selfReportedChannel: LeadSelfReportedChannel | null;
  /** Свободный текст самоотчёта — только в шифр. */
  selfReportedNote: string | null;
  dataNoticeVersion: string;
  consentState: LeadConsentState;
  sessionRef: string | null;
  contentSlug: string | null;
  placementCode: string | null;
  /** Сырые метки (очистка — `core/utm.ts` на сервере). */
  utm: Record<string, unknown> | null;
  elapsedMs: number | null;
}

export type LeadValidation =
  | {
      ok: true;
      value: LeadInput;
      /** Ловушка заполнена: ответ «как успех», без записи. */
      trap: boolean;
      /** Слишком быстрое заполнение — мягкая пометка. */
      suspectedSpam: boolean;
      /** Отброшенные мягкие поля атрибуции (без значений). */
      dropped: string[];
    }
  | { ok: false; fields: LeadFieldIssue[] };

const PUBLIC_KEY_RE = /^pp_[A-Za-z0-9]{24}$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@.]{2,63}$/;
const TELEGRAM_RE = /^@?[A-Za-z][A-Za-z0-9_]{4,31}$/;
const TELEGRAM_LINK_RE = /^https:\/\/t\.me\/[A-Za-z][A-Za-z0-9_]{4,31}$/;
const SESSION_REF_RE = /^[A-Za-z0-9_-]{8,100}$/;
const SLUG_RE = /^[a-z0-9-]{3,80}$/;
const PLACEMENT_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const NOTICE_RE = /^[A-Za-z0-9._-]{1,50}$/;

const len = (s: string) => Array.from(s).length;

function isOneOf<T extends string>(list: readonly T[], v: unknown): v is T {
  return typeof v === 'string' && (list as readonly string[]).includes(v);
}

/** Проверка контакта по способу связи (значение — обрезанное). */
export function contactIssue(
  method: LeadContactMethod,
  contact: string,
): string | null {
  switch (method) {
    case 'email':
      return contact.length <= 254 && EMAIL_RE.test(contact) ? null : 'format';
    case 'phone': {
      if (!/^\+?[0-9 ().-]{7,30}$/.test(contact)) return 'format';
      const digits = contact.replace(/\D/g, '');
      return digits.length >= 7 && digits.length <= 15 ? null : 'format';
    }
    case 'telegram':
      return TELEGRAM_RE.test(contact) || TELEGRAM_LINK_RE.test(contact)
        ? null
        : 'format';
    default:
      return len(contact) >= 3 && len(contact) <= 200 ? null : 'length';
  }
}

export function validateLeadBody(raw: unknown): LeadValidation {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, fields: [{ field: '$', code: 'type' }] };
  }
  const b = raw as Record<string, unknown>;
  const fields: LeadFieldIssue[] = [];
  const dropped: string[] = [];
  const str = (k: string): string | null =>
    typeof b[k] === 'string' ? (b[k] as string).trim() : null;
  const required = (k: string, min: number, max: number): string => {
    const v = str(k);
    if (v === null || v === '') {
      fields.push({
        field: k,
        code: b[k] === undefined || v === '' ? 'required' : 'type',
      });
      return '';
    }
    if (len(v) < min || len(v) > max) fields.push({ field: k, code: 'length' });
    return v;
  };

  const key = str('key') ?? '';
  if (!PUBLIC_KEY_RE.test(key))
    fields.push({
      field: 'key',
      code: b.key === undefined ? 'required' : 'format',
    });
  const submissionKey = (str('submissionKey') ?? '').toLowerCase();
  if (!UUID_RE.test(submissionKey)) {
    fields.push({
      field: 'submissionKey',
      code: b.submissionKey === undefined ? 'required' : 'format',
    });
  }
  const name = required('name', 1, LEAD_NAME_MAX);
  const method = b.contactMethod;
  if (!isOneOf(LEAD_CONTACT_METHODS, method)) {
    fields.push({
      field: 'contactMethod',
      code: method === undefined ? 'required' : 'enum',
    });
  }
  const contact = required('contact', 1, 254);
  if (contact && isOneOf(LEAD_CONTACT_METHODS, method)) {
    const issue = contactIssue(method, contact);
    if (issue) fields.push({ field: 'contact', code: issue });
  }
  const business = required('business', 1, LEAD_BUSINESS_MAX);
  const task = required('task', 1, LEAD_TASK_MAX);
  let budgetRange: LeadBudgetRange | null = null;
  if (
    b.budgetRange !== undefined &&
    b.budgetRange !== null &&
    b.budgetRange !== ''
  ) {
    if (isOneOf(LEAD_BUDGET_RANGES, b.budgetRange)) budgetRange = b.budgetRange;
    else fields.push({ field: 'budgetRange', code: 'enum' });
  }
  let selfReportedChannel: LeadSelfReportedChannel | null = null;
  let selfReportedNote: string | null = null;
  if (b.selfReported !== undefined && b.selfReported !== null) {
    const sr = b.selfReported as Record<string, unknown>;
    if (typeof sr !== 'object' || Array.isArray(sr)) {
      fields.push({ field: 'selfReported', code: 'type' });
    } else {
      if (isOneOf(LEAD_SELF_REPORTED_CHANNELS, sr.channel))
        selfReportedChannel = sr.channel;
      else fields.push({ field: 'selfReported.channel', code: 'enum' });
      if (sr.note !== undefined && sr.note !== null) {
        if (typeof sr.note !== 'string' || len(sr.note.trim()) > 300) {
          fields.push({ field: 'selfReported.note', code: 'length' });
        } else if (sr.note.trim()) {
          selfReportedNote = sr.note.trim();
        }
      }
    }
  }
  const dataNoticeVersion = str('dataNoticeVersion') ?? '';
  if (!NOTICE_RE.test(dataNoticeVersion)) {
    fields.push({
      field: 'dataNoticeVersion',
      code: b.dataNoticeVersion === undefined ? 'required' : 'format',
    });
  }
  const consentState = b.consentState;
  if (!isOneOf(LEAD_CONSENT_STATES, consentState)) {
    fields.push({
      field: 'consentState',
      code: consentState === undefined ? 'required' : 'enum',
    });
  }
  const soft = (k: string, re: RegExp): string | null => {
    const v = b[k];
    if (v === undefined || v === null || v === '') return null;
    if (typeof v === 'string' && re.test(v.trim())) return v.trim();
    dropped.push(k);
    return null;
  };
  const sessionRef = soft('sessionRef', SESSION_REF_RE);
  const contentSlug = soft('contentSlug', SLUG_RE);
  const placementCode = soft('placementCode', PLACEMENT_RE);
  let utm: Record<string, unknown> | null = null;
  if (b.utm !== undefined && b.utm !== null) {
    if (typeof b.utm === 'object' && !Array.isArray(b.utm))
      utm = b.utm as Record<string, unknown>;
    else dropped.push('utm');
  }
  if (b.hp !== undefined && typeof b.hp !== 'string')
    fields.push({ field: 'hp', code: 'type' });
  const trap = typeof b.hp === 'string' && b.hp.trim() !== '';
  const elapsedMs =
    typeof b.elapsedMs === 'number' &&
    Number.isFinite(b.elapsedMs) &&
    b.elapsedMs >= 0
      ? Math.floor(b.elapsedMs)
      : null;

  if (fields.length > 0) return { ok: false, fields };
  return {
    ok: true,
    trap,
    suspectedSpam: elapsedMs !== null && elapsedMs < LEAD_FAST_FILL_MS,
    dropped,
    value: {
      key,
      submissionKey,
      name,
      contactMethod: method as LeadContactMethod,
      contact,
      business,
      task,
      budgetRange,
      selfReportedChannel,
      selfReportedNote,
      dataNoticeVersion,
      consentState: consentState as LeadConsentState,
      sessionRef,
      contentSlug,
      placementCode,
      utm,
      elapsedMs,
    },
  };
}
