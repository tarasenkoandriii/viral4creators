/**
 * Курсы валют аукциона (ТЗ на маркетплейс §22) — статичная таблица, не
 * живой курс через внешний API: единственное реальное применение —
 * (а) грубая оценка расхода в USD для отчёта (§26), где estimateAmount-
 * MicroUsd('WAYFORPAY', ...) жёстко предполагает копейки UAH (см.
 * common/billing-pricing.ts) и её сигнатуру трогать рискованно — другие
 * потребители (подписки, кредиты) всегда в UAH; (б) информационная
 * оценка цены для зрителя из другой страны на фронте (не авторитетная
 * сумма сделки — платёж всегда идёт в валюте, которую выбрал продавец).
 *
 * Курсы приблизительные и требуют периодического ручного обновления —
 * тот же честный подход, что уже применён к оценке 'ffmpeg-api' в
 * common/ai-pricing.ts (там тоже написано «ПРОВЕРИТЬ»).
 */

import type { AuctionCurrencyValue } from './types/marketplace.types';

/** Сколько гривен за одну единицу валюты — ПРОВЕРИТЬ и обновлять периодически. */
const UAH_PER_UNIT: Record<AuctionCurrencyValue, number> = {
  UAH: 1,
  USD: 41.5,
  EUR: 45,
};

/** Сумма в минорных единицах (копейках) UAH — только для внутренней оценки расхода, не для реального платежа. */
export function toUahMinorUnits(amountMajor: number, currency: AuctionCurrencyValue): number {
  return Math.round(amountMajor * UAH_PER_UNIT[currency] * 100);
}

/**
 * Грубая конверсия для отображения зрителю — не более того. Округление
 * до целого нарочно грубое (не показываем ложную точность у оценки,
 * которая и так на статичном курсе).
 */
export function convertForDisplay(amountMajor: number, from: AuctionCurrencyValue, to: AuctionCurrencyValue): number {
  if (from === to) return amountMajor;
  const uah = amountMajor * UAH_PER_UNIT[from];
  return Math.round((uah / UAH_PER_UNIT[to]) * 100) / 100;
}

/** Страна (ISO-2, из заголовка x-vercel-ip-country) → локальная валюта, для конвертации-подсказки на фронте. */
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
