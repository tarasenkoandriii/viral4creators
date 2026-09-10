/**
 * Цены оплаты — подписки Standard/Premium и пакеты кредитов на генерацию
 * (ТЗ §41, этап 62).
 *
 * ## Плейсхолдеры, не решение владельца продукта
 *
 * Числа ниже — заготовки, чтобы код и вебхуки заработали end-to-end уже
 * сейчас. Реальные суммы — открытый вопрос §41 (см.
 * PRODUCT-PROJECT-SPEC.md): их меняют через переменные окружения, без
 * деплоя кода, тем же приёмом, что суточные потолки расхода
 * (`spend-limits.ts`) — сознательно тот же файл-паттерн, чтобы у двух
 * похожих задач не разъезжались решения.
 *
 * ## Почему у каждой цены два числа, а не одно с курсом
 *
 * Stars (XTR) и WayForPay (UAH) — разные платёжные системы с разной
 * ценовой психологией (Stars округляют к «круглым» числам в звёздах,
 * WayForPay — к «99 копейкам»), и курс между ними не фиксирован биржей —
 * значит переводить одно в другое автоматически means подстраивать одну
 * цену под другую, а не устанавливать обе независимо. Отсюда же
 * `amountMicroUsd` в `Payment` — оценочная величина по ОТДЕЛЬНОМУ
 * фиксированному курсу (ниже), только для сведения с отчётами `AiUsage`,
 * не бухгалтерская точность.
 */

import { PlanId } from './plans';
import { DEFAULT_LOCALE, SupportedLocale } from './locale';

/** XTR не делится на копейки — суммы всегда целые. */
export interface SubscriptionPriceDefinition {
  stars: number;
  /** Минорные единицы валюты WayForPay (копейки UAH). */
  wayforpayMinor: number;
  wayforpayCurrency: string;
}

export interface CreditPackDefinition {
  id: string;
  title: string;
  /** Сколько роликов даёт пакет (CreditLedger.grant при успешной оплате). */
  credits: number;
  stars: number;
  wayforpayMinor: number;
  wayforpayCurrency: string;
}

const DEFAULT_CURRENCY = 'UAH';

const DEFAULT_SUBSCRIPTION_PRICES: Record<
  'STANDARD' | 'PREMIUM',
  SubscriptionPriceDefinition
> = {
  STANDARD: {
    stars: 1000,
    wayforpayMinor: 79900,
    wayforpayCurrency: DEFAULT_CURRENCY,
  },
  PREMIUM: {
    stars: 2500,
    wayforpayMinor: 199900,
    wayforpayCurrency: DEFAULT_CURRENCY,
  },
};

/** Два тира — «попробовать» и «на проект» — как и у suscription-планов,
 * больше тиров можно добавить, не трогая механику (см. CREDIT_PACKS ниже
 * и env-переопределения только по этим двум ключам). */
const DEFAULT_CREDIT_PACKS: CreditPackDefinition[] = [
  {
    id: 'small',
    title: '5 роликов',
    credits: 5,
    stars: 250,
    wayforpayMinor: 19900,
    wayforpayCurrency: DEFAULT_CURRENCY,
  },
  {
    id: 'large',
    title: '20 роликов',
    credits: 20,
    stars: 900,
    wayforpayMinor: 69900,
    wayforpayCurrency: DEFAULT_CURRENCY,
  },
];

/**
 * Локализованные названия пакетов (аудит 2026-09-08, Г-5.2): `title` в
 * `DEFAULT_CREDIT_PACKS` выше остаётся русским по умолчанию (используется,
 * когда локаль не распознана), здесь — перевод под остальные четыре.
 * Ключ словаря — `id` пакета, а не число роликов, чтобы соответствие не
 * потерялось, если появится тир с тем же числом, но другой ценой.
 */
const PACK_TITLE: Readonly<Record<SupportedLocale, Record<string, string>>> = {
  ru: { small: '5 роликов', large: '20 роликов' },
  uk: { small: '5 роликів', large: '20 роликів' },
  en: { small: '5 videos', large: '20 videos' },
  de: { small: '5 Videos', large: '20 Videos' },
  es: { small: '5 vídeos', large: '20 vídeos' },
};

/** Целое неотрицательное число из env — мусор/пусто → fallback, тот же
 * приём, что `positiveIntFromEnv` в `configuration.ts`, но без запрета
 * нуля (нулевая цена — законный промо-инструмент, не ошибка конфига). */
function intFromEnv(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

export function subscriptionPriceFor(
  plan: Extract<PlanId, 'STANDARD' | 'PREMIUM'>,
  env: NodeJS.ProcessEnv = process.env,
): SubscriptionPriceDefinition {
  const base = DEFAULT_SUBSCRIPTION_PRICES[plan];
  return {
    stars: intFromEnv(env, `SUBSCRIPTION_PRICE_${plan}_STARS`, base.stars),
    wayforpayMinor: intFromEnv(
      env,
      `SUBSCRIPTION_PRICE_${plan}_UAH_KOPECKS`,
      base.wayforpayMinor,
    ),
    wayforpayCurrency: env.WAYFORPAY_CURRENCY || base.wayforpayCurrency,
  };
}

export function creditPacks(
  locale: SupportedLocale = DEFAULT_LOCALE,
  env: NodeJS.ProcessEnv = process.env,
): CreditPackDefinition[] {
  return DEFAULT_CREDIT_PACKS.map((pack) => ({
    ...pack,
    title: PACK_TITLE[locale]?.[pack.id] ?? pack.title,
    credits: intFromEnv(
      env,
      `CREDIT_PACK_${pack.id.toUpperCase()}_CREDITS`,
      pack.credits,
    ),
    stars: intFromEnv(
      env,
      `CREDIT_PACK_${pack.id.toUpperCase()}_STARS`,
      pack.stars,
    ),
    wayforpayMinor: intFromEnv(
      env,
      `CREDIT_PACK_${pack.id.toUpperCase()}_UAH_KOPECKS`,
      pack.wayforpayMinor,
    ),
    wayforpayCurrency: env.WAYFORPAY_CURRENCY || pack.wayforpayCurrency,
  }));
}

export function creditPackById(
  packId: string,
  locale: SupportedLocale = DEFAULT_LOCALE,
  env: NodeJS.ProcessEnv = process.env,
): CreditPackDefinition | undefined {
  return creditPacks(locale, env).find((pack) => pack.id === packId);
}

/**
 * Фиксированный курс для `Payment.amountMicroUsd` (§41, открытый
 * вопрос — не живая биржа). Ставки — грубые ориентиры конца 2025/начала
 * 2026: Stars продаются Telegram по ~$0.013-0.02 за штуку в зависимости
 * от региона покупки, гривна — около 0.024 $/₴. Переопределяются env, а
 * не пересчитываются по API курсов: отчёт не обязан быть бухгалтерски
 * точным, обязан быть стабильным между перезапусками.
 */
const USD = 1_000_000;

export function estimateAmountMicroUsd(
  method: 'STARS' | 'WAYFORPAY',
  amount: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (method === 'STARS') {
    const rate = Number(env.FX_MICRO_USD_PER_STAR) || 0.015 * USD;
    return Math.round(amount * rate);
  }
  // WayForPay: amount — минорные единицы (копейки UAH).
  const rate = Number(env.FX_MICRO_USD_PER_UAH_KOPECK) || (0.024 * USD) / 100;
  return Math.round(amount * rate);
}
