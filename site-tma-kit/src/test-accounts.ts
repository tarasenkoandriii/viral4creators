/**
 * Тестовые учётные записи сайта (Э-С Ш2) — маршруты кабинета
 * `/sites/:siteId/test-accounts` (sites-backend, модуль `site-credentials`)
 * и правила формы. Один реестр на обучалку генератора и QA: завёл здесь —
 * видно в TMA генератора и QA-TMA.
 *
 * Пароль — только на запись: сервер его не отдаёт, форма правки начинается
 * с пустого поля, пустое значение в запрос не уходит.
 */

import type { ApiClient } from './api-client';

/**
 * Кому разрешена учётка. `assist-admin` (Э-С Ш3) — обход «Админки»
 * помощника за логином браузерным воркером.
 */
export type TestAccountProduct = 'tutorial' | 'qa' | 'assist-admin';

export interface TestAccountSecrets {
  password: boolean;
  loginFields: boolean;
  session: boolean;
}

export interface TestAccount {
  id: string;
  siteId: string;
  label: string;
  role: string | null;
  plan: string | null;
  username: string | null;
  hostIds: string[];
  products: string[];
  /** active | frozen | expired */
  status: string;
  confirmedTestAccount: boolean;
  createdBy: 'tma' | 'generator' | 'other';
  secrets: TestAccountSecrets;
  lastUsedAt: string | null;
  expiresAt: string;
}

export interface TestAccountPayload {
  label?: string;
  role?: string | null;
  plan?: string | null;
  username?: string | null;
  password?: string;
  hostIds?: string[];
  products?: TestAccountProduct[];
  lifetimeDays?: number;
  status?: 'active' | 'frozen';
  confirmedTestAccount?: boolean;
}

export const TEST_ACCOUNT_ROLE_HINTS = [
  'guest',
  'customer',
  'manager',
  'admin',
] as const;
export const TEST_ACCOUNT_LIFETIME_DAYS = [7, 30, 90] as const;

/** Коды отказов модуля `site-credentials`, у которых есть свой текст. */
export const TEST_ACCOUNT_ERROR_CODES = [
  'TEST_ACCOUNT_INVALID',
  'TEST_ACCOUNT_NOT_FOUND',
  'CREDENTIALS_NOT_CONFIGURED',
] as const;
export type TestAccountErrorCode = (typeof TEST_ACCOUNT_ERROR_CODES)[number];

export function isTestAccountErrorCode(v: unknown): v is TestAccountErrorCode {
  return (
    typeof v === 'string' &&
    (TEST_ACCOUNT_ERROR_CODES as readonly string[]).includes(v)
  );
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {};
const str = (v: unknown): string | null =>
  typeof v === 'string' && v ? v : null;
const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/** Разбор строгий: неизвестный статус — `expired` (аренды нет), флаги — только `true`. */
export function parseTestAccount(v: unknown): TestAccount {
  const o = obj(v);
  const s = obj(o.secrets);
  const status =
    o.status === 'active' || o.status === 'frozen' ? o.status : 'expired';
  return {
    id: String(o.id ?? ''),
    siteId: String(o.siteId ?? ''),
    label: String(o.label ?? ''),
    role: str(o.role),
    plan: str(o.plan),
    username: str(o.username),
    hostIds: strs(o.hostIds),
    products: strs(o.products),
    status,
    confirmedTestAccount: o.confirmedTestAccount === true,
    createdBy:
      o.createdBy === 'tma' || o.createdBy === 'generator'
        ? o.createdBy
        : 'other',
    secrets: {
      password: s.password === true,
      loginFields: s.loginFields === true,
      session: s.session === true,
    },
    lastUsedAt: str(o.lastUsedAt),
    expiresAt: String(o.expiresAt ?? ''),
  };
}

const enc = encodeURIComponent;

export function createTestAccountsApi(client: ApiClient) {
  const base = (siteId: string) => `/sites/${enc(siteId)}/test-accounts`;
  return {
    list: async (siteId: string) => {
      const r = await client.request<unknown>('GET', base(siteId));
      return (Array.isArray(r) ? r : []).map(parseTestAccount);
    },
    create: async (siteId: string, payload: TestAccountPayload) =>
      parseTestAccount(await client.request('POST', base(siteId), payload)),
    update: async (siteId: string, id: string, payload: TestAccountPayload) =>
      parseTestAccount(
        await client.request('PATCH', `${base(siteId)}/${enc(id)}`, payload)
      ),
    remove: async (siteId: string, id: string) => {
      const r = obj(
        await client.request('DELETE', `${base(siteId)}/${enc(id)}`)
      );
      return { deleted: r.deleted === true };
    },
  };
}

export type TestAccountsApi = ReturnType<typeof createTestAccountsApi>;

// ── форма ──

export interface TestAccountForm {
  label: string;
  role: string;
  plan: string;
  username: string;
  password: string;
  hostIds: string[];
  products: TestAccountProduct[];
  /** `null` — не менять срок (правка). */
  lifetimeDays: number | null;
  confirmedTestAccount: boolean;
}

export type TestAccountFormError =
  'labelRequired' | 'hostRequired' | 'productRequired' | 'confirmRequired';

export function emptyTestAccountForm(hostIds: string[]): TestAccountForm {
  return {
    label: '',
    role: '',
    plan: '',
    username: '',
    password: '',
    hostIds,
    products: ['tutorial', 'qa'],
    lifetimeDays: 90,
    confirmedTestAccount: false,
  };
}

export function testAccountForm(a: TestAccount): TestAccountForm {
  return {
    label: a.label,
    role: a.role ?? '',
    plan: a.plan ?? '',
    username: a.username ?? '',
    password: '',
    hostIds: [...a.hostIds],
    products: a.products.filter(
      (p): p is TestAccountProduct =>
        p === 'tutorial' || p === 'qa' || p === 'assist-admin'
    ),
    lifetimeDays: null,
    confirmedTestAccount: a.confirmedTestAccount,
  };
}

const orNull = (v: string) => (v.trim() ? v.trim() : null);

export function testAccountRequest(
  form: TestAccountForm,
  isNew: boolean
): { payload: TestAccountPayload } | { error: TestAccountFormError } {
  if (!form.label.trim()) return { error: 'labelRequired' };
  if (form.hostIds.length === 0) return { error: 'hostRequired' };
  if (form.products.length === 0) return { error: 'productRequired' };
  if (isNew && !form.confirmedTestAccount) return { error: 'confirmRequired' };
  const payload: TestAccountPayload = {
    label: form.label.trim(),
    role: orNull(form.role),
    plan: orNull(form.plan),
    username: orNull(form.username),
    hostIds: [...new Set(form.hostIds)],
    products: [...new Set(form.products)],
    confirmedTestAccount: form.confirmedTestAccount,
  };
  if (form.password) payload.password = form.password;
  if (form.lifetimeDays !== null) payload.lifetimeDays = form.lifetimeDays;
  return { payload };
}

export function toggleItem<T>(list: T[], item: T): T[] {
  return list.includes(item) ? list.filter((x) => x !== item) : [...list, item];
}
