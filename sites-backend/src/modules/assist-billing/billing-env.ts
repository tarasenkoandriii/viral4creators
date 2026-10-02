/**
 * Переменные оплаты Помощника — ОДНО место чтения (doc/DEPLOYMENT.md §6.12).
 *
 *  - Stars выставляет БОТ ПОМОЩНИКА (`ASSIST_BOT_TOKEN`, §4.1): звёзды
 *    начисляются боту, выставившему счёт; бот генератора не участвует.
 *  - WayForPay — свой мерчант помощника (`ASSIST_WAYFORPAY_*`): у генератора
 *    свои env (`WAYFORPAY_*`), продукты и выручка не смешиваются; один и тот
 *    же мерчант можно указать в обоих — решает владелец.
 *  - Курсы USD → UAH / Stars — env (цены §7.1 — ориентир в USD, к оплате —
 *    гривна и Stars, §7.1 «по курсу»): владелец меняет без деплоя кода.
 *  - Ключ шифра recToken — производный от `ASSIST_SECRETS_KEY` (как ключ
 *    visitor-token виджета), без нового секрета.
 */

import { createHmac } from 'crypto';
import type { PaymentRates } from './plans';

export const DEFAULT_UAH_PER_USD = 41.5;
/**
 * Stars за доллар — то, что бот получает при выводе (≈ $0.013 за звезду,
 * ПРОВЕРИТЬ у Telegram на дату запуска; вопрос владельцу).
 */
export const DEFAULT_STARS_PER_USD = 77;
/** Потолок суммы подписки Stars (`subscription_period`) — ПРОВЕРИТЬ в Bot API. */
export const DEFAULT_STARS_SUBSCRIPTION_MAX = 10_000;

const PAYMENT_TOKEN_LABEL = 'assist-payment-token-v1';

function positive(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const v = Number(raw);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export function paymentRates(
  env: NodeJS.ProcessEnv = process.env,
): PaymentRates {
  return {
    uahPerUsd: positive(env.ASSIST_UAH_PER_USD, DEFAULT_UAH_PER_USD),
    starsPerUsd: positive(env.ASSIST_STARS_PER_USD, DEFAULT_STARS_PER_USD),
  };
}

export function starsSubscriptionMax(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return Math.floor(
    positive(env.ASSIST_STARS_SUBSCRIPTION_MAX, DEFAULT_STARS_SUBSCRIPTION_MAX),
  );
}

export interface WayForPayConfig {
  merchantAccount: string;
  merchantSecret: string;
  domain: string;
}

export function wayforpayConfig(
  env: NodeJS.ProcessEnv = process.env,
): WayForPayConfig | null {
  const merchantAccount = env.ASSIST_WAYFORPAY_MERCHANT_ACCOUNT?.trim();
  const merchantSecret = env.ASSIST_WAYFORPAY_MERCHANT_SECRET?.trim();
  const domain = env.ASSIST_WAYFORPAY_DOMAIN?.trim();
  if (!merchantAccount || !merchantSecret || !domain) return null;
  return { merchantAccount, merchantSecret, domain };
}

export function assistBotToken(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  return env.ASSIST_BOT_TOKEN?.trim() || null;
}

/** Публичный origin sites-backend — для `serviceUrl` WayForPay. */
export function sitesPublicUrl(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const raw = env.SITES_PUBLIC_URL?.trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.hostname !== 'localhost') return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** Куда вернуть человека после формы WayForPay — экран тарифа TMA. */
export function billingReturnUrl(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const base = env.ASSIST_TMA_URL?.trim();
  if (!base) return null;
  return `${base.replace(/#.*$/, '').replace(/\/+$/, '')}/#/billing`;
}

/** Ключ AES-256 для recToken (base64 32 байта) или null — нет ASSIST_SECRETS_KEY. */
export function paymentTokenKey(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const key = env.ASSIST_SECRETS_KEY?.trim();
  if (!key) return null;
  return createHmac('sha256', key).update(PAYMENT_TOKEN_LABEL).digest('base64');
}

/** Документы (§3.1, §6.1, №49): версии — в коде, тексты — по ссылкам юриста. */
export const LEGAL_DOCUMENTS = {
  terms: { version: '2026-10-04-draft', env: 'ASSIST_TERMS_URL' },
  dpa: { version: '2026-10-04-draft', env: 'ASSIST_DPA_URL' },
} as const;
export type LegalDocument = keyof typeof LEGAL_DOCUMENTS;

export function legalUrl(
  doc: LegalDocument,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const raw = env[LEGAL_DOCUMENTS[doc].env]?.trim();
  if (!raw) return null;
  try {
    return new URL(raw).protocol === 'https:' ? raw : null;
  } catch {
    return null;
  }
}
