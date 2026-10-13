/**
 * Логика формы обращения без React (проектный документ §13.4; ТЗ §8.3,
 * §19; тест — `scripts/lead-form.test.ts`).
 *
 * Валидация — ОБЩИЙ модуль сервера (`src/shared/lead-validation.ts` —
 * копия `contracts/lead-validation.ts`, сверяется `sync-shared --check`):
 * сайт проверяет ровно то тело, которое отправит, теми же правилами.
 *
 * Успех — ТОЛЬКО 200/201 с `leadRef` (AT-CORE-03): любой другой ответ,
 * обрыв, таймаут, «успешный» ответ без номера — «не відправлено».
 */
import {
  LEAD_BUDGET_RANGES,
  LEAD_CONTACT_METHODS,
  LEAD_SELF_REPORTED_CHANNELS,
  type LeadBody,
  type LeadBudgetRange,
  type LeadConsentState,
  type LeadContactMethod,
  type LeadFieldIssue,
  type LeadSelfReportedChannel,
  validateLeadBody,
} from '@/shared/lead-validation';
import type { Attribution } from './attribution';

export { LEAD_BUDGET_RANGES, LEAD_CONTACT_METHODS, LEAD_SELF_REPORTED_CHANNELS };
export type { LeadBudgetRange, LeadContactMethod, LeadSelfReportedChannel };

export interface LeadFields {
  name: string;
  contactMethod: LeadContactMethod | '';
  contact: string;
  business: string;
  task: string;
  budgetRange: LeadBudgetRange | '';
  selfReported: LeadSelfReportedChannel | '';
}

export const EMPTY_FIELDS: LeadFields = {
  name: '',
  contactMethod: '',
  contact: '',
  business: '',
  task: '',
  budgetRange: '',
  selfReported: '',
};

/** Поля формы в порядке на странице (фокус — на первое ошибочное). */
export const FIELD_ORDER = [
  'name',
  'contactMethod',
  'contact',
  'business',
  'task',
  'budgetRange',
  'selfReported',
] as const;
export type FieldName = (typeof FIELD_ORDER)[number];

export interface LeadContext {
  publicKey: string;
  dataNoticeVersion: string;
  consentState: LeadConsentState;
  contentSlug?: string;
  attribution: Attribution;
  elapsedMs: number;
  hp: string;
}

export function buildBody(f: LeadFields, ctx: LeadContext, submissionKey: string): LeadBody {
  const body: LeadBody = {
    key: ctx.publicKey,
    submissionKey,
    name: f.name,
    contactMethod: f.contactMethod as LeadContactMethod,
    contact: f.contact,
    business: f.business,
    task: f.task,
    dataNoticeVersion: ctx.dataNoticeVersion,
    consentState: ctx.consentState,
    hp: ctx.hp,
    elapsedMs: Math.max(0, Math.round(ctx.elapsedMs)),
  };
  if (f.budgetRange) body.budgetRange = f.budgetRange;
  if (f.selfReported) body.selfReported = { channel: f.selfReported };
  if (ctx.attribution.sessionRef) body.sessionRef = ctx.attribution.sessionRef;
  if (ctx.attribution.utm) body.utm = ctx.attribution.utm as Record<string, string>;
  if (ctx.attribution.placementCode) body.placementCode = ctx.attribution.placementCode;
  if (ctx.contentSlug) body.contentSlug = ctx.contentSlug;
  return body;
}

/** Ключ словаря `form.errors.*` для ошибки поля. */
export type ErrorKey =
  | 'required'
  | 'method'
  | 'email'
  | 'phone'
  | 'telegram'
  | 'other'
  | 'nameLength'
  | 'businessLength'
  | 'taskLength'
  | 'enum'
  | 'generic';

export type FieldErrors = Partial<Record<FieldName, ErrorKey>>;

/** Ошибки поля сервера/общего валидатора → ошибки полей формы. */
export function mapIssues(issues: LeadFieldIssue[], method: LeadContactMethod | ''): FieldErrors {
  const out: FieldErrors = {};
  for (const { field, code } of issues) {
    const name = (field === 'selfReported.channel' ? 'selfReported' : field) as FieldName;
    if (!FIELD_ORDER.includes(name) || out[name]) continue;
    let key: ErrorKey = 'generic';
    if (name === 'contactMethod') key = 'method';
    else if (code === 'required') key = 'required';
    else if (code === 'enum') key = 'enum';
    else if (name === 'contact') key = method ? (method as ErrorKey) : 'generic';
    else if (name === 'name' && code === 'length') key = 'nameLength';
    else if (name === 'business' && code === 'length') key = 'businessLength';
    else if (name === 'task' && code === 'length') key = 'taskLength';
    out[name] = key;
  }
  return out;
}

/** Проверка до отправки — тем же валидатором, что на сервере. */
export function validateFields(f: LeadFields, ctx: LeadContext): FieldErrors {
  const res = validateLeadBody(buildBody(f, ctx, '00000000-0000-4000-8000-000000000000'));
  if (res.ok) return {};
  return mapIssues(res.fields, f.contactMethod);
}

export function firstInvalid(errors: FieldErrors): FieldName | null {
  return FIELD_ORDER.find((n) => errors[n]) ?? null;
}

/** Отпечаток полей: та же попытка (повтор) ⇔ тот же отпечаток ⇒ тот же `submissionKey`. */
export function fingerprint(f: LeadFields): string {
  return JSON.stringify(FIELD_ORDER.map((n) => f[n]));
}

export type SubmitOutcome =
  | { kind: 'success'; leadRef: string }
  | { kind: 'validation'; errors: FieldErrors }
  | { kind: 'rate_limited'; retryAfterSec: number | null; altContact: unknown }
  | { kind: 'closed'; altContact: unknown }
  | { kind: 'reused' }
  | { kind: 'server' }
  | { kind: 'network' };

const LEAD_REF_RE = /^L-[A-Z0-9]{4,20}$/;

/** Ответ сервера → исход попытки. Успех — только 200/201 с `leadRef`. */
export function classifyResponse(
  status: number,
  json: unknown,
  method: LeadContactMethod | '',
  retryAfterHeader?: string | null,
): SubmitOutcome {
  const body = (json ?? null) as {
    success?: boolean;
    data?: { leadRef?: unknown };
    error?: { code?: string; details?: Record<string, unknown> };
  } | null;
  if (
    (status === 200 || status === 201) &&
    body?.success === true &&
    typeof body.data?.leadRef === 'string' &&
    LEAD_REF_RE.test(body.data.leadRef)
  ) {
    return { kind: 'success', leadRef: body.data.leadRef };
  }
  const code = body?.success === false ? body.error?.code : undefined;
  const details = body?.error?.details ?? {};
  if (status === 400 && code === 'PUB_VALIDATION' && Array.isArray(details.fields)) {
    const errors = mapIssues(details.fields as LeadFieldIssue[], method);
    // Ошибка поля, которого нет в форме (ключ, версия уведомления) — это не вина посетителя.
    return Object.keys(errors).length ? { kind: 'validation', errors } : { kind: 'server' };
  }
  if (status === 429) {
    const fromDetails = typeof details.retryAfterSec === 'number' ? details.retryAfterSec : null;
    const fromHeader = retryAfterHeader && /^\d{1,6}$/.test(retryAfterHeader) ? Number(retryAfterHeader) : null;
    return { kind: 'rate_limited', retryAfterSec: fromDetails ?? fromHeader, altContact: details.altContact ?? null };
  }
  if (status === 503 && code === 'PUB_FORM_CLOSED') return { kind: 'closed', altContact: details.altContact ?? null };
  if (status === 409 && code === 'PUB_IDEMPOTENCY_REUSED') return { kind: 'reused' };
  return { kind: 'server' };
}

/** Время ожидания для текста 429: минуты (вверх), до минуты — секунды. */
export function waitParts(sec: number | null): { unit: 'minutes' | 'seconds'; n: number } {
  const s = sec === null || !Number.isFinite(sec) || sec <= 0 ? 600 : Math.ceil(sec);
  return s >= 60 ? { unit: 'minutes', n: Math.ceil(s / 60) } : { unit: 'seconds', n: s };
}
