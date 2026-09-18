/**
 * Квоты генерации изображений на пользователя (doc/AI-SKETCH-SPEC.md §8.2).
 *
 * Сейчас их расходует одно место — фотореалистичное превью персонажа
 * (`CharacterPreviewService`, §6.8 ТЗ). Будущий ИИ-скетч тратит ту же
 * квоту (§5.4), поэтому имена переменных окружения уже «скетчевые»:
 * настроенные сегодня значения не придётся переименовывать.
 *
 * Считаем ЧИСЛО оплаченных вызовов, а не деньги: одна картинка стоит
 * центы, общий суточный бюджет тарифа (§26.4) она выберет нескоро, а
 * нажать «сгенерировать» сотню раз подряд можно за минуту.
 *
 * Чистый модуль — без Nest-инъекций, ради юнит-теста в изоляции.
 */
import type { PlanId } from './plans';

export interface ImageQuota {
  day: number;
  month: number;
}

/**
 * Операции, которые расходуют ЭТУ квоту. Превью персонажа и ИИ-скетч —
 * два вызова одной модели за одни деньги, и лимит у них общий: пока
 * каждая операция считалась отдельно, фактический потолок был вдвое
 * выше обещанного в §8.2 (аудит A-10). Тип — `AiOperation`, но импорт
 * сюда не тянем: модуль намеренно чистый.
 */
export const IMAGE_OPERATIONS = ['ai-sketch', 'character-preview'] as const;

const DEFAULTS: Record<PlanId, ImageQuota> = {
  LITE: { day: 3, month: 20 },
  STANDARD: { day: 15, month: 150 },
  PREMIUM: { day: 50, month: 600 },
};

export const IMAGE_QUOTA_ENV: Record<PlanId, { day: string; month: string }> = {
  LITE: { day: 'AI_SKETCH_DAY_LITE', month: 'AI_SKETCH_MONTH_LITE' },
  STANDARD: {
    day: 'AI_SKETCH_DAY_STANDARD',
    month: 'AI_SKETCH_MONTH_STANDARD',
  },
  PREMIUM: {
    day: 'AI_SKETCH_DAY_PREMIUM',
    month: 'AI_SKETCH_MONTH_PREMIUM',
  },
};

/** Целое ≥ 0 из env; мусор или пусто — значение по умолчанию. Ноль —
 * законный способ временно закрыть генерацию на тарифе. */
function intFrom(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

export function imageQuotaFor(
  plan: PlanId,
  env: NodeJS.ProcessEnv = process.env,
): ImageQuota {
  const base = DEFAULTS[plan];
  return {
    day: intFrom(env, IMAGE_QUOTA_ENV[plan].day, base.day),
    month: intFrom(env, IMAGE_QUOTA_ENV[plan].month, base.month),
  };
}

/** Начало текущего месяца по UTC — та же граница, что у суток
 * (`startOfDayUtc`) и у месячной свёртки расходов. */
export function startOfMonthUtc(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export interface ImageQuotaUsage {
  dayUsed: number;
  monthUsed: number;
}

/** Какой лимит выбран первым: сначала сутки (короче ждать), потом месяц. */
export function exhaustedQuota(
  usage: ImageQuotaUsage,
  quota: ImageQuota,
): 'day' | 'month' | null {
  if (usage.dayUsed >= quota.day) return 'day';
  if (usage.monthUsed >= quota.month) return 'month';
  return null;
}
