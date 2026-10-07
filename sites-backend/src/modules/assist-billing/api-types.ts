/**
 * Контракт кабинета «Тариф и оплата» (TMA `assist/` ↔ sites-backend, Э4).
 * Деньги наружу — в USD (ориентир) и в валюте платежа минимальными
 * единицами (копейки UAH, целые Stars).
 */
import type { AssistPlanId, PaidPlanId } from './plans';
import type { SubscriptionStatus } from './subscription-state';

export type PaymentMethod = 'stars' | 'wayforpay';

export interface BillingPlanView {
  id: AssistPlanId;
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
  /** Цена к оплате; у trial — null (не продаётся). */
  price: { uahMinor: number; stars: number } | null;
}

export interface BillingOverview {
  plan: {
    id: AssistPlanId | null;
    status: SubscriptionStatus;
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
    /** Лимит периода: тариф + докупка (без авто-пакета). */
    limit: number;
    planUnits: number;
    extraUnits: number;
    /** Авто-пакет, который можно занять сверх лимита сейчас. */
    autoAllowance: number;
  };
  autoTopUp: {
    enabled: boolean;
    capUsd: number;
    spentUsd: number;
    /** Можно ли включить: тариф с докупкой и карта (recToken WayForPay). */
    available: boolean;
  };
  plans: BillingPlanView[];
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
  /** Только владельцу — остальным пусто. */
  payments: Array<{
    id: string;
    kind: string;
    planId: string | null;
    units: number | null;
    method: string;
    status: string;
    currency: string;
    amountMinor: number;
    createdAt: string;
    paidAt: string | null;
  }>;
  /** Оплачивать и менять настройки может только владелец кабинета. */
  canPay: boolean;
  dialogWeights: { text: number; voice: number; admin: number };
}

export type CheckoutRequest =
  | { kind: 'subscription'; planId: PaidPlanId; method: PaymentMethod }
  | { kind: 'topup'; packs: number; method: PaymentMethod };

export interface CheckoutResult {
  paymentId: string;
  method: PaymentMethod;
  /** Stars: открыть `Telegram.WebApp.openInvoice(url)`. */
  starsInvoiceUrl?: string;
  /** WayForPay: POST-форма на их страницу (TMA строит <form>). */
  wayforpay?: { url: string; fields: Record<string, string> };
}

export interface LegalAcceptRequest {
  accept: Array<'terms' | 'dpa'>;
  evalConsent?: boolean;
}

export interface AutoTopUpRequest {
  enabled: boolean;
  capUsd: number;
}

export interface PaymentStatusView {
  id: string;
  status: string;
  kind: string;
  planId: string | null;
}

export type BillingErrorCode =
  | 'LEGAL_REQUIRED'
  | 'PAYMENT_METHOD_UNAVAILABLE'
  | 'PLAN_INVALID'
  | 'TOPUP_UNAVAILABLE'
  | 'AUTO_TOPUP_UNAVAILABLE'
  | 'BILLING_INVALID'
  | 'PAYMENT_NOT_FOUND'
  /** Внутренний тенант платформы (`ASSIST_INTERNAL_SITE_IDS`) — платить нечего. */
  | 'INTERNAL_PLAN';
