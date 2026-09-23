/**
 * Суточные потолки расхода (ТЗ §26.4, этап 32).
 *
 * Этап 31 показал, во что обходится каждый пользователь. Естественное
 * продолжение — не дать одному пользователю потратить весь бюджет за
 * вечер. До этого потолки были только у SerpApi и YouTube (поштучные
 * квоты §7.5), а самый дорогой вызов — генерация Veo — не был ограничен
 * ничем: сто нажатий кнопки за день стоили сотню рендеров.
 *
 * ## Почему в деньгах, а не в штуках
 *
 * Штуки врут: разбор десятисекундного ролика и разбор трёхминутного
 * стоят по-разному, а Veo Standard дороже Lite почти втрое. Потолок в
 * деньгах ограничивает ровно то, что тратится.
 *
 * ## Почему пользователь их не видит в долларах
 *
 * Все режимы сейчас бесплатны, и показывать человеку «вы потратили $1.20
 * из $3.00» значит объяснять ему внутреннюю кухню вместо ответа на его
 * вопрос. Потолок живёт внутри, а наружу выходит человеческой фразой:
 * «дневной лимит исчерпан, попробуйте завтра».
 *
 * ## Анонимные
 *
 * Отдельный ОБЩИЙ потолок на всех анонимных за сутки. Персонального у
 * них быть не может — у анонимного пути нет пользователя, а UUID сессии
 * бесплатно минтится сколько угодно раз. Без общего потолка достаточно
 * было бы выйти из аккаунта, чтобы обойти персональный: дыра ровно в
 * том месте, ради которого потолки и заводятся.
 */

import { ForbiddenException } from '@nestjs/common';
import { PlanId, PLAN_IDS } from './plans';

/**
 * Отдельный класс ошибки для «суточный лимит расхода исчерпан» (Е-1.2
 * шестого аудита, этап 76). До этой правки `assertCanSpendUser()` бросал
 * обычный `ForbiddenException` — воркеры партии/A-B
 * (`catalog-batch-worker.service.ts`, `ab-test-worker.service.ts`)
 * классифицируют ошибки по имени класса (`NON_RETRYABLE_NAMES`), и этот
 * же класс использует «пользователь заблокирован»/«план не позволяет» —
 * оба ДЕЙСТВИТЕЛЬНО постоянные. Суточный лимит — временный (сбрасывается
 * следующие сутки), но по имени класса был неотличим от постоянных
 * причин и уводил строку партии в FAILED навсегда. Остаётся подклассом
 * `ForbiddenException` — HTTP-статус 403 и поведение на обычных
 * маршрутах не меняются, различается только имя класса, по которому
 * воркеры теперь могут отличить «подождать до завтра» от «не повторять
 * никогда».
 */
export class DailySpendLimitExceededException extends ForbiddenException {}

/** Потолки по умолчанию, в микродолларах на сутки. */
const USD = 1_000_000;

const DEFAULTS: Record<PlanId, number> = {
  // ~8 быстрых генераций Veo Lite в сутки плюс разборы вокруг них.
  LITE: 2 * USD,
  STANDARD: 10 * USD,
  // Поднято с $30 (доп. запрос владельца продукта, 2026-09-12): Premium
  // упирался в дневной лимит быстрее, чем ожидалось.
  PREMIUM: 100 * USD,
};

/** Общий потолок на ВСЕХ анонимных за сутки. */
const DEFAULT_ANONYMOUS = 5 * USD;

/**
 * Потолок тестового аккаунта на отмеченных сценариях (TODO §III п.37).
 *
 * Именно потолок, а не «без ограничений». Бесплатный проход снимает
 * стоимость С ПОЛЬЗОВАТЕЛЯ, но не с нас: провайдеру платим в любом
 * случае. Аккаунт без потолка — это один забытый цикл повторов и
 * выбранный за ночь бюджет, причём на счёте, который специально сделали
 * безнаказанным. Значение подобрано так, чтобы полный проход сценария с
 * генерацией и аватаром (порядка $1–2) повторялся много раз за день и
 * всё же упирался в край.
 */
const DEFAULT_TEST_USER = 20 * USD;

export const PLAN_LIMIT_ENV: Record<PlanId, string> = {
  LITE: 'DAILY_SPEND_LIMIT_USD_LITE',
  STANDARD: 'DAILY_SPEND_LIMIT_USD_STANDARD',
  PREMIUM: 'DAILY_SPEND_LIMIT_USD_PREMIUM',
};

export const ANONYMOUS_LIMIT_ENV = 'DAILY_SPEND_LIMIT_USD_ANONYMOUS';

export const TEST_USER_LIMIT_ENV = 'DAILY_SPEND_LIMIT_USD_TEST_USER';

/**
 * Значение переменной окружения в микродолларах. Задаётся в ДОЛЛАРАХ —
 * как и ставки прайса, по той же причине.
 *
 * `0` — законное значение и означает «платные вызовы запрещены»
 * (например, чтобы приостановить траты на время разбирательства). А вот
 * мусор в переменной не должен молча превратиться в ноль и остановить
 * сервис: тогда остаётся значение по умолчанию.
 */
function limitFrom(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const dollars = Number(raw);
  if (!Number.isFinite(dollars) || dollars < 0) return fallback;
  return Math.round(dollars * USD);
}

export function dailyLimitForPlan(
  plan: PlanId,
  env: NodeJS.ProcessEnv = process.env,
): number {
  return limitFrom(env, PLAN_LIMIT_ENV[plan], DEFAULTS[plan]);
}

export function dailyLimitForAnonymous(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return limitFrom(env, ANONYMOUS_LIMIT_ENV, DEFAULT_ANONYMOUS);
}

export function dailyLimitForTestUser(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return limitFrom(env, TEST_USER_LIMIT_ENV, DEFAULT_TEST_USER);
}

/** Все потолки разом — для вкладки «Расходы» и проверки настроек. */
export function allDailyLimits(env: NodeJS.ProcessEnv = process.env): {
  byPlan: Record<PlanId, number>;
  anonymous: number;
  testUser: number;
} {
  const byPlan = {} as Record<PlanId, number>;
  for (const id of PLAN_IDS) byPlan[id] = dailyLimitForPlan(id, env);
  return {
    byPlan,
    anonymous: dailyLimitForAnonymous(env),
    testUser: dailyLimitForTestUser(env),
  };
}

export interface BudgetVerdict {
  allowed: boolean;
  limitMicroUsd: number;
  spentMicroUsd: number;
  remainingMicroUsd: number;
}

/**
 * Хватит ли остатка. Проверка идёт ДО вызова, а стоимость вызова заранее
 * неизвестна, поэтому правило простое: пустить, пока потолок не выбран
 * целиком. Один вызов может перебрать лимит — и это сознательно: резать
 * генерацию посередине или угадывать её цену заранее хуже, чем позволить
 * последнему вызову выйти за край.
 */
export function checkBudget(
  spentMicroUsd: number,
  limitMicroUsd: number,
): BudgetVerdict {
  const remaining = Math.max(limitMicroUsd - spentMicroUsd, 0);
  return {
    allowed: spentMicroUsd < limitMicroUsd,
    limitMicroUsd,
    spentMicroUsd,
    remainingMicroUsd: remaining,
  };
}

/**
 * Текст отказа. Без долларов и без слова «лимит бюджета»: пользователю
 * важно, что делать дальше, а не как устроен наш учёт.
 */
/**
 * Отказ тестовому аккаунту.
 *
 * Отдельный текст обязателен: общая фраза «дневной лимит генераций
 * исчерпан» у тестировщика читается как «бесплатный доступ сломался», и
 * дальше он идёт чинить не то. Здесь надо сказать, что доступ работает,
 * а упёрлись в его собственный потолок.
 */
export function testBudgetDeniedMessage(): string {
  return 'Дневной потолок тестового доступа исчерпан. Бесплатный проход сценариев работает, но не безлимитен: потолок обновится завтра.';
}

export function budgetDeniedMessage(anonymous: boolean): string {
  return anonymous
    ? 'Дневной лимит бесплатных генераций для гостей исчерпан. Войдите через Telegram — у вошедших свой, больший лимит, — или попробуйте завтра.'
    : 'Дневной лимит генераций исчерпан. Он обновится завтра; уже созданные проекты и ролики остаются доступны.';
}

/** Начало текущих суток по UTC — окно, за которое считается расход. */
export function startOfDayUtc(now: Date = new Date()): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}
