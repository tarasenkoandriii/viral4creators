/**
 * Ключи настроек советника — «Тонкая красная линия» §5.8, §10.
 *
 * Отдельный файл, а не константы внутри сервиса: их читает
 * `WizardHintService` (тянет за собой SDK модели, Prisma, учёт расхода)
 * и правит `AdminWizardGuideService` (не тянет ничего). Держать их в
 * первом значило бы заставить админскую карточку импортировать всю
 * машинерию вызова ради двух строк.
 *
 * Умолчания здесь же и намеренно консервативные: фича платит за каждый
 * шаг каждого пользователя, и «забыли настроить» должно стоить дёшево,
 * а не дорого.
 */

const USD = 1_000_000;

export const AI_GUIDE_ENABLED_KEY = 'ai_guide_enabled';
export const AI_GUIDE_BUDGET_KEY = 'ai_guide_daily_budget_micro_usd';
export const AI_GUIDE_PERSONAL_LIMIT_KEY = 'ai_guide_personal_limit';

/** $2/сутки на всю фичу (§5.8). Исчерпан — молчим, оператору алерт. */
export const DEFAULT_DAILY_BUDGET_MICRO_USD = 2 * USD;

/**
 * 40 подсказок в сутки одному человеку (§5.8). У лендингового
 * ассистента личного лимита нет вовсе — он анонимен; здесь он
 * обязателен, иначе один открытый на день мастер выбирает общий бюджет.
 */
export const DEFAULT_PERSONAL_LIMIT = 40;

/**
 * Разбор числовой настройки.
 *
 * Мусор не должен молча выключать фичу: ноль — законное значение
 * («приостановить»), отрицательное и нечисловое — нет, и они дают
 * умолчание, а не ноль.
 */
export function numberSettingValue(
  raw: string | null | undefined,
  fallback: number,
): number {
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
