/**
 * Порог остатка и повод написать в канал ошибок (TODO §III п.36,
 * этап 143) — последний открытый кусок страницы «Балансы».
 *
 * ## Зачем, если страница уже есть
 *
 * Страница отвечает тому, кто на неё зашёл. Кончившийся баланс тем и
 * опасен, что заходить на неё в этот день никто не собирался: продукт
 * встаёт, и узнаётся это по ошибке генерации у живого пользователя —
 * ровно то, ради чего страницу и заводили.
 *
 * ## Почему пороги разные, а не один
 *
 * Остаток у трёх провайдеров меряется в трёх разных вещах: доллары,
 * символы синтеза, поиски. Общего порога у них быть не может, а
 * привести одно к другому нельзя без курса, которого у нас нет (этап
 * 142: цена символа зависит от тарифа). Поэтому порог свой у каждого.
 *
 * ## Что означает ноль
 *
 * «Не сторожить ЭТОГО провайдера» — целиком, а не только по порогу
 * (аудит этапа 143). Прежняя редакция нулём выключала лишь сравнение с
 * порогом, а крик «остаток не читается» оставляла, и выключить его
 * было нечем. Живой случай на это и напрашивается: у аккаунта xAI на
 * постоплате предоплаченного остатка нет ВООБЩЕ, код это прямо так и
 * пишет — и сторож слал бы про это сообщение каждый день, вечно, про
 * состояние, которое не чинится. Канал, который кричит про нечинимое,
 * перестают читать целиком, вместе с тем, что чинится.
 *
 * ## Почему «остаток не прочитан» — всё-таки повод
 *
 * Сторож, который перестал видеть, обязан сказать об этом сам.
 * Молчащая проверка неотличима от проверки, у которой всё хорошо, и
 * это худший из возможных исходов: страница показывает прочерк, а в
 * канал не приходит ничего. Поэтому повод остаётся — у тех
 * провайдеров, которых просили сторожить.
 *
 * «Не настроено» и «провайдер остатка не отдаёт» поводом НЕ считаются:
 * это известные состояния, они не меняются сами и крик о них каждый
 * день научит не читать канал.
 */

import { ProviderBalance } from './xai-balance';

export interface BalanceThresholds {
  /** Ниже скольких долларов беспокоить. Ноль — не сторожить. */
  usd: number;
  /** Порог в единицах провайдера: символы, поиски. Ноль — не сторожить. */
  units: Record<string, number>;
}

export interface BalanceConcern {
  provider: string;
  kind: 'low' | 'unreadable';
  /** Готовая строка для канала — без переменных частей в отпечатке. */
  text: string;
}

/** Отпечаток для дедупликации: провайдер и повод, ничего переменного. */
export function concernFingerprint(concern: BalanceConcern): string {
  return `balance-${concern.kind}:${concern.provider}`;
}

function positive(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw.trim());
  // Мусор в переменной — не повод сторожить наугад: возвращаем
  // умолчание, а не ноль. Ноль здесь значит «выключено», и опечатка,
  // тихо выключившая сторожа, — худший исход из возможных.
  if (!Number.isFinite(value) || value < 0) return fallback;
  return value;
}

/** Пороги из окружения. Умолчания рассчитаны на «хватит ещё на день-два». */
export function thresholdsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): BalanceThresholds {
  return {
    usd: positive(env.BALANCE_ALERT_USD, 10),
    units: {
      ELEVENLABS: positive(env.BALANCE_ALERT_ELEVENLABS_CHARACTERS, 20_000),
      SERPAPI: positive(env.BALANCE_ALERT_SERPAPI_SEARCHES, 100),
    },
  };
}

function money(microUsd: number): string {
  return `$${(microUsd / 1_000_000).toFixed(2)}`;
}

function amount(value: number): string {
  return value.toLocaleString('ru-RU');
}

/**
 * Порог, с которым сравнивают ИМЕННО ЭТУ строку. Ноль (или отсутствие)
 * значит «не сторожить».
 *
 * Порог выбирается по виду остатка, а не только по провайдеру: у кого
 * остаток в своих единицах — свой порог, у кого в деньгах — общий
 * `BALANCE_ALERT_USD`. Сравнить кредиты с долларами было бы хуже, чем
 * не сравнивать вовсе: число получилось бы, а смысла в нём нет.
 */
export function limitFor(
  item: Pick<ProviderBalance, 'provider' | 'units' | 'amountMicroUsd'>,
  thresholds: BalanceThresholds,
): number {
  if (item.units) return thresholds.units[item.provider] ?? 0;
  if (item.amountMicroUsd !== undefined) return thresholds.usd;
  // Остаток не прочитан — вида у него нет. Сторожим, если у провайдера
  // есть хоть какой-то порог: свой в единицах или общий денежный.
  return thresholds.units[item.provider] ?? thresholds.usd;
}

export interface BalanceWatchResult {
  /**
   * Сколько провайдеров сторожили на самом деле. Не то же, что число
   * строк: у семерых остатка не спрашивают вовсе, а у выключенных
   * нулём — не сторожат. Без этого числа выключенный сторож выглядит
   * в истории крона в точности как здоровый (аудит этапа 143).
   */
  watched: number;
  concerns: BalanceConcern[];
}

/** О чём стоит написать — и скольких при этом вообще сторожили. */
export function balanceWatch(
  items: ProviderBalance[],
  thresholds: BalanceThresholds,
): BalanceWatchResult {
  const concerns: BalanceConcern[] = [];
  let watched = 0;
  for (const item of items) {
    // Сторожить нечего у того, у кого остатка не спрашивают вовсе.
    if (item.state !== 'ok' && item.state !== 'error') continue;
    // Ноль — «не сторожить этого провайдера», включая крик о том, что
    // остаток не читается: иначе нечинимое состояние кричало бы вечно.
    const limit = limitFor(item, thresholds);
    if (limit <= 0) continue;
    watched++;

    if (item.state === 'error') {
      concerns.push({
        provider: item.provider,
        kind: 'unreadable',
        text:
          `Остаток ${item.provider} не читается: ${item.detail ?? 'причина неизвестна'}. ` +
          'Пока это так, порог по нему не сторожит ничего.',
      });
      continue;
    }

    if (item.amountMicroUsd !== undefined) {
      if (item.amountMicroUsd < limit * 1_000_000) {
        concerns.push({
          provider: item.provider,
          kind: 'low',
          text: `Остаток ${item.provider}: ${money(item.amountMicroUsd)} — ниже порога ${money(limit * 1_000_000)}.`,
        });
      }
      continue;
    }

    if (item.units && item.units.left < limit) {
      concerns.push({
        provider: item.provider,
        kind: 'low',
        text:
          `Остаток ${item.provider}: ${amount(item.units.left)} ${item.units.label} — ` +
          `ниже порога ${amount(limit)}.`,
      });
    }
  }
  return { watched, concerns };
}
