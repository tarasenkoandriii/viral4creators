/**
 * Курсы валют аукциона — зеркало backend/src/common/fx-rates.ts (два
 * независимых приложения монорепо, общего пакета для этого нет, тот же
 * принцип, что уже применён к escapeXml между landing/marketplace).
 *
 * Единственное применение здесь — информационная оценка цены для
 * зрителя из другой страны (по заголовку x-vercel-ip-country). Не
 * авторитетная сумма сделки: платёж всегда идёт в валюте, которую
 * выбрал продавец (AuctionListing.payoutCurrency).
 *
 * Курсы приблизительные, обновлять периодически вручную вместе с
 * бэкенд-копией — держать оба места в курсе изменений придётся руками,
 * раз общего пакета для этой мелкой таблицы нет.
 */

export type AuctionCurrencyValue = 'UAH' | 'USD' | 'EUR';

const UAH_PER_UNIT: Record<AuctionCurrencyValue, number> = {
  UAH: 1,
  USD: 41.5,
  EUR: 45,
};

export function convertForDisplay(amountMajor: number, from: AuctionCurrencyValue, to: AuctionCurrencyValue): number {
  if (from === to) return amountMajor;
  const uah = amountMajor * UAH_PER_UNIT[from];
  return Math.round((uah / UAH_PER_UNIT[to]) * 100) / 100;
}

/** Страна (ISO-2, из заголовка x-vercel-ip-country) → локальная валюта. */
export const COUNTRY_CURRENCY: Record<string, AuctionCurrencyValue> = {
  UA: 'UAH',
  US: 'USD',
  DE: 'EUR',
  ES: 'EUR',
  FR: 'EUR',
  IT: 'EUR',
  NL: 'EUR',
  AT: 'EUR',
  PT: 'EUR',
  IE: 'EUR',
  FI: 'EUR',
};
