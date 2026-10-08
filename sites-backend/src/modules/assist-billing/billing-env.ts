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
 *    visitor-token виджета), без нового секрета. №60 (Р-З10-12): ключи
 *    всех версий общей связки (`common/secrets-keyring.ts`); строка ключа
 *    — прежний формат token-crypto (версию узнаёт расшифровка, Р-З10-25).
 */

import {
  derivedKeys,
  openWithKeys,
  type DerivedKeys,
} from '../../common/secrets-keyring';
import { decryptToken, encryptToken } from '../../shared/token-crypto';
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

/**
 * ТЕКУЩИЙ ключ AES-256 для recToken (base64 32 байта) или null — нет
 * ASSIST_SECRETS_KEY. Шифровать/читать — `sealPaymentToken`/`openPaymentToken`
 * (они знают и прежние версии ключа).
 */
export function paymentTokenKey(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  return paymentTokenKeys(env)?.currentKey.toString('base64') ?? null;
}

/** Ключи recToken всех версий; null — нет ASSIST_SECRETS_KEY. */
export function paymentTokenKeys(
  env: NodeJS.ProcessEnv = process.env,
): DerivedKeys | null {
  return derivedKeys(env, PAYMENT_TOKEN_LABEL);
}

/** recToken → строка для `recTokenEnc` текущим ключом; null — ключа нет. */
export function sealPaymentToken(
  plain: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const keys = paymentTokenKeys(env);
  if (!keys) return null;
  return encryptToken(plain, keys.currentKey.toString('base64'));
}

/** `recTokenEnc` → recToken (любая версия ключа связки); null — не открылось. */
export function openPaymentToken(
  enc: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): { value: string; version: string } | null {
  const keys = paymentTokenKeys(env);
  if (!enc || !keys) return null;
  return openWithKeys(keys, enc, (body, key) => {
    try {
      return decryptToken(body, key.toString('base64'));
    } catch {
      return null;
    }
  });
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
