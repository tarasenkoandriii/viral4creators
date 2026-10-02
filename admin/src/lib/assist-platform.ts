// Вкладка «Помощник» (ТЗ ИИ-помощника §8, пункты 1–5 и 8; Э4). Данные —
// из sites-backend через прокси backend/src/modules/admin-panel
// (AdminAssistController → внутренний API с секретом). Формы ответов —
// sites-backend/src/modules/platform-admin/platform-admin.service.ts.

import { apiDelete, apiGet, apiPatch, apiPost } from './admin-api';

export interface AssistSummary {
  days: number;
  accounts: number;
  assistAccounts: number;
  assistSites: number;
  hostsByStatus: Array<{ status: string; count: number }>;
  subscriptions: Array<{ planId: string; status: string; count: number }>;
  dialogsPerDay: Array<{ day: string; count: number }>;
  spendUsd: number;
  revenueUsd: number;
  marginUsd: number;
  revenueByPlan: Array<{ planId: string | null; usd: number; payments: number }>;
  answers: number;
  refusals: Array<{ rule: string; count: number }>;
}

export interface AssistAccountRow {
  accountId: string;
  ownerTelegramId: string | null;
  createdAt: string;
  sites: number;
  domains: string[];
  plan: string | null;
  status: string;
  method: string;
  paidThrough: string | null;
  units: number;
  limit: number;
}

export interface AssistAccountDetail {
  accountId: string;
  createdAt: string;
  type: string;
  region: string;
  state: {
    planId: string | null;
    status: string;
    method: string;
    periodStart: string | null;
    periodEnd: string | null;
    paidThrough: string | null;
  };
  usage: { units: number; dialogs: number; extraUnits: number; autoPacks: number; limit: number };
  subscription: {
    planId: string;
    status: string;
    method: string;
    anchorAt: string;
    paidThrough: string;
    cancelAtPeriodEnd: boolean;
    autoTopUp: boolean;
    autoTopUpCapUsd: number;
    renewAttempts: number;
    lastRenewError: string | null;
    note: string | null;
  } | null;
  sites: Array<{
    siteId: string;
    name: string;
    enabled: boolean;
    chatPaused: boolean;
    blocked: boolean;
    dailyCapUsd: number | null;
    widgetVersion: number;
    hosts: Array<{ host: string; status: string; expiresAt: string | null }>;
  }>;
  payments: Array<{
    id: string;
    kind: string;
    planId: string | null;
    units: number | null;
    method: string;
    status: string;
    currency: string;
    amountMinor: number;
    amountUsd: number;
    failureReason: string | null;
    createdAt: string;
    paidAt: string | null;
  }>;
  legal: Array<{ document: string; version: string; evalConsent: boolean; acceptedAt: string; current: boolean }>;
}

export interface AssistReviewRow {
  messageId: string;
  accountId: string;
  siteId: string;
  conversationId: string;
  question: string | null;
  answer: string;
  flags: string[];
  rating: number | null;
  createdAt: string;
  evalConsent: boolean;
}

export interface AssistAbuse {
  suspicious: Array<{ siteId: string; accountId: string; suspicious: number; total: number }>;
  spikes: Array<{ siteId: string; today: number; avgPerDay: number }>;
  optOut: Array<{ domain: string; source: string; createdAt: string }>;
}

export interface AssistSettings {
  widget: { enabled: boolean; dailyCapUsd: number | null };
  env: { widgetEnabled: boolean; platformDailyCapUsd: number; sandboxPublicEnabled: boolean };
  models: { chat: string; embeddings: string };
  rates: { uahPerUsd: number; starsPerUsd: number };
  plans: Array<{ id: string; priceUsdMonthly: number; dialogsPerMonth: number; overageUsdPer100: number | null }>;
  legal: Record<string, { version: string; env: string }>;
}

export interface AssistCosts {
  days: number;
  byOperation: Array<{ operation: string; usd: number; calls: number }>;
  topSites: Array<{ siteId: string; accountId: string | null; costUsd: number; accountRevenueUsd: number }>;
}

export const assistApi = {
  summary: (days: number) => apiGet<AssistSummary>('/admin/assist/summary', { days }),
  accounts: (q: string) => apiGet<AssistAccountRow[]>('/admin/assist/accounts', { q: q || undefined, limit: 50 }),
  account: (id: string) => apiGet<AssistAccountDetail>(`/admin/assist/accounts/${encodeURIComponent(id)}`),
  setPlan: (id: string, planId: string, days: number, note?: string) =>
    apiPost<AssistAccountDetail>(`/admin/assist/accounts/${encodeURIComponent(id)}/plan`, { planId, days, note }),
  extend: (id: string, days: number) =>
    apiPost<AssistAccountDetail>(`/admin/assist/accounts/${encodeURIComponent(id)}/extend`, { days }),
  message: (id: string, text: string) =>
    apiPost<{ sent: number }>(`/admin/assist/accounts/${encodeURIComponent(id)}/message`, { text }),
  setSite: (siteId: string, body: { blocked?: boolean; dailyCapUsd?: number | null }) =>
    apiPatch<AssistAccountDetail>(`/admin/assist/sites/${encodeURIComponent(siteId)}`, body),
  review: (days: number) => apiGet<AssistReviewRow[]>('/admin/assist/review', { days, limit: 100 }),
  addToEval: (messageId: string) =>
    apiPost<{ added: boolean }>(`/admin/assist/review/${encodeURIComponent(messageId)}/eval`, {}),
  abuse: (days: number) => apiGet<AssistAbuse>('/admin/assist/abuse', { days }),
  addOptOut: (domain: string) => apiPost<{ domain: string }>('/admin/assist/opt-out', { domain }),
  removeOptOut: (domain: string) =>
    apiDelete<{ removed: number }>(`/admin/assist/opt-out/${encodeURIComponent(domain)}`),
  settings: () => apiGet<AssistSettings>('/admin/assist/settings'),
  setSettings: (body: { enabled?: boolean; dailyCapUsd?: number | null }) =>
    apiPatch<AssistSettings>('/admin/assist/settings', body),
  costs: (days: number) => apiGet<AssistCosts>('/admin/assist/costs', { days }),
};

export function fmtUsd(v: number): string {
  if (v === 0) return '$0';
  if (Math.abs(v) < 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(2)}`;
}

export function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
}

export function fmtMinor(amountMinor: number, currency: string): string {
  return currency === 'XTR' ? `${amountMinor} ⭐` : `${(amountMinor / 100).toFixed(2)} ${currency}`;
}

/**
 * Поле «потолок, USD» → значение для PATCH. Пусто — null («как в env»);
 * запятая как десятичный разделитель допустима. Мусор, отрицательное и
 * больше 1000 (граница сервера) — отказ: раньше `Number('5,5')` давал NaN,
 * а `JSON.stringify(NaN)` — `null`, т.е. опечатка молча СНИМАЛА потолок.
 */
export function parseCapUsd(raw: string): { ok: true; value: number | null } | { ok: false } {
  const s = raw.trim().replace(',', '.');
  if (s === '') return { ok: true, value: null };
  if (!/^\d+(\.\d+)?$/.test(s)) return { ok: false };
  const v = Number(s);
  if (!Number.isFinite(v) || v < 0 || v > 1000) return { ok: false };
  return { ok: true, value: v };
}

/** Срок ручного тарифа/продления: целое 1…730 дней, иначе null. */
export function parseDays(raw: number): number | null {
  return Number.isInteger(raw) && raw >= 1 && raw <= 730 ? raw : null;
}

/**
 * Действие оператора — только после подтверждения: ручной тариф, продление,
 * блокировка, рубильник, потолок, opt-out, eval, сообщение владельцу.
 * `ask` — `window.confirm` (в тестах — подмена).
 */
export function confirmThen<T>(
  text: string,
  run: () => Promise<T>,
  ask: (text: string) => boolean = (t) => window.confirm(t),
): Promise<T> | null {
  return ask(text) ? run() : null;
}
