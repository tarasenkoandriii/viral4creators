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

// ── Пороги сведения дублей (§6.4, этап 10) ──────────────────────────

export const SIBLING_AUTO_KEY = 'ai_guide_sibling_auto';
export const SIBLING_SUGGEST_KEY = 'ai_guide_sibling_suggest';

/**
 * Выше этого — сводим сами; выше нижнего — показываем оператору с
 * процентом; ниже — заводим новую ситуацию.
 *
 * Умолчания взяты из §6.4 и заведомо не окончательны: выставить их
 * правильно заранее нельзя, а данные копятся сами — `matchScore`
 * хранится у КАЖДОГО кандидата, включая отвергнутых и сведённых руками.
 * Поэтому оба порога — настройки, а не константы.
 */
export const DEFAULT_SIBLING_AUTO = 0.85;
export const DEFAULT_SIBLING_SUGGEST = 0.5;

/**
 * Разбор порога.
 *
 * Отдельно от `numberSettingValue`, потому что здесь другая область
 * допустимого: доля от нуля до единицы. Единица означает «никогда не
 * сводить автоматически» — законная настройка, а не ошибка.
 */
export function thresholdValue(
  raw: string | null | undefined,
  fallback: number,
): number {
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
}
