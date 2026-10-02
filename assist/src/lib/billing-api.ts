/**
 * Тариф и оплата (Э4; ТЗ §3.10, §7.1): клиент `/assist/billing/*` и чистые
 * помощники экрана. Контракт — `sites-backend/src/modules/assist-billing/
 * api-types.ts`. Разбор строгий, как у остальных клиентов TMA:
 * - тариф и способ оплаты — только из известного списка;
 * - ссылка Stars — только `https://t.me/…`, форма WayForPay — только
 *   `https://secure.wayforpay.com/…` (чужой адрес из ответа не открываем);
 * - числа — конечные и неотрицательные.
 */

import type { ApiClient } from '../kit';
import { num, iso } from './handoff-api';
import { arr, count, obj, oneOf, str, text } from './widget-api';

export const BILLING_PLAN_IDS = ['trial', 'start', 'business', 'pro'] as const;
export type BillingPlanId = (typeof BILLING_PLAN_IDS)[number];
export const PAID_PLAN_IDS = ['start', 'business', 'pro'] as const;
export type PaidPlanId = (typeof PAID_PLAN_IDS)[number];
export type PaymentMethod = 'stars' | 'wayforpay';
export const PLAN_STATUSES = [
  'trial',
  'active',
  'grace',
  'expired',
  'none',
] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export interface BillingPlan {
  id: BillingPlanId;
  priceUsdMonthly: number;
  dialogsPerMonth: number;
  sites: number;
  knowledgePages: number;
  documents: number;
  telegramOperators: number;
  retentionDays: number;
  overageUsdPer100: number | null;
  voice: boolean;
  video: boolean;
  adminRead: boolean;
  adminActions: boolean;
  removePoweredBy: boolean;
  price: { uahMinor: number; stars: number } | null;
}

export interface BillingPayment {
  id: string;
  kind: string;
  planId: string | null;
  units: number | null;
  method: string;
  status: string;
  currency: string;
  amountMinor: number;
  createdAt: string | null;
  paidAt: string | null;
}

export interface BillingOverview {
  plan: {
    id: BillingPlanId | null;
    status: PlanStatus;
    method: string;
    periodStart: string | null;
    periodEnd: string | null;
    paidThrough: string | null;
    renews: boolean;
    cancelAtPeriodEnd: boolean;
  };
  usage: {
    units: number;
    dialogs: number;
    limit: number;
    planUnits: number;
    extraUnits: number;
    autoAllowance: number;
  };
  autoTopUp: {
    enabled: boolean;
    capUsd: number;
    spentUsd: number;
    available: boolean;
  };
  plans: BillingPlan[];
  topup: {
    packUnits: number;
    maxPacks: number;
    priceUsdPer100: number;
    pricePerPack: { uahMinor: number; stars: number };
  } | null;
  methods: { stars: boolean; wayforpay: boolean };
  legal: {
    terms: { version: string; url: string | null; accepted: boolean };
    dpa: { version: string; url: string | null; accepted: boolean };
    evalConsent: boolean;
  };
  payments: BillingPayment[];
  canPay: boolean;
  dialogWeights: { text: number; voice: number; admin: number };
}

export type CheckoutRequest =
  | { kind: 'subscription'; planId: PaidPlanId; method: PaymentMethod }
  | { kind: 'topup'; packs: number; method: PaymentMethod };

export interface CheckoutResult {
  paymentId: string;
  method: PaymentMethod;
  starsInvoiceUrl: string | null;
  wayforpay: { url: string; fields: Record<string, string> } | null;
}

export interface BillingApi {
  overview(): Promise<BillingOverview>;
  acceptLegal(evalConsent: boolean): Promise<void>;
  checkout(req: CheckoutRequest): Promise<CheckoutResult>;
  payment(id: string): Promise<{ id: string; status: string }>;
  setAutoTopUp(enabled: boolean, capUsd: number): Promise<BillingOverview>;
  setCancel(cancel: boolean): Promise<BillingOverview>;
}

const nn = (v: unknown): number => {
  const x = num(v);
  return x !== null && x >= 0 ? x : 0;
};
const bool = (v: unknown): boolean => v === true;

function price(v: unknown): { uahMinor: number; stars: number } | null {
  const o = obj(v);
  if (v === null || !Object.keys(o).length) return null;
  return { uahMinor: count(o.uahMinor), stars: count(o.stars) };
}

function legalDoc(v: unknown) {
  const o = obj(v);
  const url = str(o.url);
  return {
    version: text(o.version),
    url: url && /^https:\/\//.test(url) ? url : null,
    accepted: bool(o.accepted),
  };
}

export function parseOverview(v: unknown): BillingOverview {
  const o = obj(v);
  const plan = obj(o.plan);
  const usage = obj(o.usage);
  const auto = obj(o.autoTopUp);
  const topup = o.topup === null ? null : obj(o.topup);
  const methods = obj(o.methods);
  const legal = obj(o.legal);
  const w = obj(o.dialogWeights);
  const planId = (BILLING_PLAN_IDS as readonly string[]).includes(
    plan.id as string
  )
    ? (plan.id as BillingPlanId)
    : null;
  return {
    plan: {
      id: planId,
      status: oneOf(PLAN_STATUSES, plan.status, 'none'),
      method: text(plan.method),
      periodStart: iso(plan.periodStart),
      periodEnd: iso(plan.periodEnd),
      paidThrough: iso(plan.paidThrough),
      renews: bool(plan.renews),
      cancelAtPeriodEnd: bool(plan.cancelAtPeriodEnd),
    },
    usage: {
      units: count(usage.units),
      dialogs: count(usage.dialogs),
      limit: count(usage.limit),
      planUnits: count(usage.planUnits),
      extraUnits: count(usage.extraUnits),
      autoAllowance: count(usage.autoAllowance),
    },
    autoTopUp: {
      enabled: bool(auto.enabled),
      capUsd: nn(auto.capUsd),
      spentUsd: nn(auto.spentUsd),
      available: bool(auto.available),
    },
    plans: arr(o.plans)
      .map((x) => obj(x))
      .filter((p) =>
        (BILLING_PLAN_IDS as readonly string[]).includes(p.id as string)
      )
      .map((p) => ({
        id: p.id as BillingPlanId,
        priceUsdMonthly: nn(p.priceUsdMonthly),
        dialogsPerMonth: count(p.dialogsPerMonth),
        sites: count(p.sites),
        knowledgePages: count(p.knowledgePages),
        documents: count(p.documents),
        telegramOperators: count(p.telegramOperators),
        retentionDays: count(p.retentionDays),
        overageUsdPer100:
          p.overageUsdPer100 === null ? null : nn(p.overageUsdPer100),
        voice: bool(p.voice),
        video: bool(p.video),
        adminRead: bool(p.adminRead),
        adminActions: bool(p.adminActions),
        removePoweredBy: bool(p.removePoweredBy),
        price: price(p.price),
      })),
    topup:
      topup && Object.keys(topup).length
        ? {
            packUnits: count(topup.packUnits),
            maxPacks: Math.max(1, count(topup.maxPacks)),
            priceUsdPer100: nn(topup.priceUsdPer100),
            pricePerPack: price(topup.pricePerPack) ?? {
              uahMinor: 0,
              stars: 0,
            },
          }
        : null,
    methods: { stars: bool(methods.stars), wayforpay: bool(methods.wayforpay) },
    legal: {
      terms: legalDoc(legal.terms),
      dpa: legalDoc(legal.dpa),
      evalConsent: bool(legal.evalConsent),
    },
    payments: arr(o.payments).map((x) => {
      const p = obj(x);
      return {
        id: text(p.id),
        kind: text(p.kind),
        planId: str(p.planId),
        units: num(p.units),
        method: text(p.method),
        status: text(p.status),
        currency: text(p.currency),
        amountMinor: count(p.amountMinor),
        createdAt: iso(p.createdAt),
        paidAt: iso(p.paidAt),
      };
    }),
    canPay: bool(o.canPay),
    dialogWeights: {
      text: count(w.text) || 1,
      voice: count(w.voice) || 2,
      admin: count(w.admin) || 3,
    },
  };
}

/** Только ссылки самого Telegram на счёт Stars. */
export function safeInvoiceUrl(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && u.hostname === 't.me' ? u.href : null;
  } catch {
    return null;
  }
}

/** Форма WayForPay — только на их домен оплаты. */
export function safeWayForPayForm(
  v: unknown
): { url: string; fields: Record<string, string> } | null {
  const o = obj(v);
  try {
    const u = new URL(text(o.url));
    if (u.protocol !== 'https:' || u.hostname !== 'secure.wayforpay.com') {
      return null;
    }
    const fields: Record<string, string> = {};
    for (const [k, val] of Object.entries(obj(o.fields))) {
      if (typeof val === 'string') fields[k] = val;
    }
    return { url: u.href, fields };
  } catch {
    return null;
  }
}

export function parseCheckout(v: unknown): CheckoutResult {
  const o = obj(v);
  return {
    paymentId: text(o.paymentId),
    method: o.method === 'wayforpay' ? 'wayforpay' : 'stars',
    starsInvoiceUrl: safeInvoiceUrl(o.starsInvoiceUrl),
    wayforpay: o.wayforpay ? safeWayForPayForm(o.wayforpay) : null,
  };
}

/** Доля лимита (0…1+) и порог предупреждения (§3.10: 80% и 100%). */
export function usageLevel(u: { units: number; limit: number }): {
  share: number;
  level: 'ok' | 'warn' | 'full';
} {
  if (u.limit <= 0) return { share: u.units > 0 ? 1 : 0, level: 'full' };
  const share = u.units / u.limit;
  return { share, level: share >= 1 ? 'full' : share >= 0.8 ? 'warn' : 'ok' };
}

/** Сумма гривны из копеек без валюты: «789», «457.50» (валюта — словарь). */
export function uahAmount(minor: number): string {
  const v = minor / 100;
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

/** Отправить форму WayForPay POST-ом (DOM). В TMA — в том же окне. */
export function submitWayForPay(form: {
  url: string;
  fields: Record<string, string>;
}): void {
  const f = document.createElement('form');
  f.method = 'POST';
  f.action = form.url;
  f.acceptCharset = 'utf-8';
  for (const [k, v] of Object.entries(form.fields)) {
    const i = document.createElement('input');
    i.type = 'hidden';
    i.name = k;
    i.value = v;
    f.appendChild(i);
  }
  document.body.appendChild(f);
  f.submit();
}

export function createBillingApi(client: ApiClient): BillingApi {
  return {
    overview: async () =>
      parseOverview(await client.request('GET', '/assist/billing')),
    acceptLegal: async (evalConsent) => {
      await client.request('POST', '/assist/billing/legal', {
        accept: ['terms', 'dpa'],
        evalConsent,
      });
    },
    checkout: async (req) =>
      parseCheckout(
        await client.request('POST', '/assist/billing/checkout', req)
      ),
    payment: async (id) => {
      const o = obj(
        await client.request(
          'GET',
          `/assist/billing/payments/${encodeURIComponent(id)}`
        )
      );
      return { id: text(o.id), status: text(o.status) };
    },
    setAutoTopUp: async (enabled, capUsd) =>
      parseOverview(
        await client.request('PATCH', '/assist/billing/auto-topup', {
          enabled,
          capUsd,
        })
      ),
    setCancel: async (cancel) =>
      parseOverview(
        await client.request('POST', '/assist/billing/cancel', { cancel })
      ),
  };
}

// ── Экран: состояние тарифа и запуск оплаты (чистая логика, проверяется скриптом) ──

/**
 * Какое предупреждение показать под счётчиком. `none` — пробный ещё не
 * начат (сайта нет): это не «тариф не действует», виджета ещё нет.
 * `grace` — продление не прошло, идёт льгота (виджет пока отвечает).
 */
export function planAlert(
  ov: Pick<BillingOverview, 'plan' | 'usage'>
): 'expired' | 'grace' | 'full' | 'warn' | null {
  if (ov.plan.status === 'expired') return 'expired';
  if (!ov.plan.id) return null;
  const lvl = usageLevel(ov.usage).level;
  if (lvl === 'full') return 'full';
  if (ov.plan.status === 'grace') return 'grace';
  return lvl === 'warn' ? 'warn' : null;
}

/** Число пакетов докупки из поля ввода: целое 1…max (пустое/мусор — 1). */
export function clampPacks(raw: unknown, max: number): number {
  const n = Math.floor(Number(raw));
  const top = Math.max(1, Math.floor(max) || 1);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, top);
}

export type InvoiceStatus = 'paid' | 'cancelled' | 'failed' | 'pending';

export interface PayDeps {
  checkout(req: CheckoutRequest): Promise<CheckoutResult>;
  /** `Telegram.WebApp.openInvoice` (null — не TMA или старый клиент). */
  openInvoice:
    ((url: string, cb: (status: InvoiceStatus) => void) => void) | null;
  /** Счёт Stars вне `openInvoice`: ссылка t.me (`openTelegramLink`/вкладка). */
  openTelegramLink(url: string): void;
  submitWayForPay(form: { url: string; fields: Record<string, string> }): void;
}

/**
 * Итог нажатия «Оплатить»:
 *  - `follow` — счёт оплачен или в обработке: опрашивать статус платежа;
 *  - `closed` — счёт закрыт без оплаты; `failed` — Telegram отказал;
 *  - `redirected` — ушли на форму WayForPay (страница уходит);
 *  - `no-method` — сервер не дал пригодного способа;
 *  - `busy` — уже идёт оплата: второй счёт НЕ создаётся.
 */
export type PayOutcome =
  | { kind: 'follow'; paymentId: string }
  | { kind: 'closed' | 'failed' | 'redirected' | 'no-method' | 'busy' };

/**
 * Оплата с замком: пока предыдущее нажатие не закончилось (чекаут, открытый
 * счёт, опрос статуса — до `release()`), повторное не вызывает `checkout`:
 * каждый вызов сервера — новая строка платежа и новый счёт. После ухода на
 * WayForPay замок не снимается (страница уходит, второй формы не будет).
 */
export function createPayer(deps: PayDeps) {
  let locked = false;
  const release = () => {
    locked = false;
  };
  const pay = async (req: CheckoutRequest): Promise<PayOutcome> => {
    if (locked) return { kind: 'busy' };
    locked = true;
    let keep = false;
    try {
      const r = await deps.checkout(req);
      if (r.method === 'stars' && r.starsInvoiceUrl) {
        const url = r.starsInvoiceUrl;
        if (deps.openInvoice) {
          const status = await new Promise<InvoiceStatus>((resolve) =>
            deps.openInvoice!(url, resolve)
          );
          if (status === 'paid' || status === 'pending') {
            keep = true;
            return { kind: 'follow', paymentId: r.paymentId };
          }
          return { kind: status === 'failed' ? 'failed' : 'closed' };
        }
        deps.openTelegramLink(url);
        keep = true;
        return { kind: 'follow', paymentId: r.paymentId };
      }
      if (r.method === 'wayforpay' && r.wayforpay) {
        keep = true;
        deps.submitWayForPay(r.wayforpay);
        return { kind: 'redirected' };
      }
      return { kind: 'no-method' };
    } finally {
      // `follow` — замок держит экран до конца опроса (release); редирект — навсегда.
      if (!keep) locked = false;
    }
  };
  return { pay, release, isLocked: () => locked };
}
