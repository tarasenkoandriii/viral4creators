/**
 * Горизонт зрелости когорты (doc/WORKFLOW-FUNNEL-COHORT-CONVERSION-SPEC.md
 * §3.2) — сколько времени должно пройти с конца окна когорты, прежде чем
 * её проценты конверсии можно показывать без пометки «ещё не завершена».
 * Оба числа — не придуманы с нуля, а выведены из уже существующих в коде
 * дедлайнов пайплайна (см. обоснование в §3.2 документа):
 *
 * SESSION: рендер Veo (`RENDER_DEADLINE_MS = 20мин`,
 * `generation.service.ts:82`) + постобработка (`POSTPROD_DEADLINE_MS =
 * 15мин`, `LEGACY_POSTPROD_DEADLINE_MS = 35мин`, `postprod.service.ts:109,115`)
 * — 55 минут худшего документированного случая, 90 минут с запасом.
 */
export const SESSION_COHORT_HORIZON_MS = 90 * 60 * 1000;

/**
 * CATALOG_BATCH_ITEM/AB_TEST_VARIANT: тот же рендер-путь (до 90 минут) +
 * ожидание своей очереди на claim → GENERATING при большой партии
 * (потолок `PROJECT_LINE_ITEM_LIMIT = 500`, `cronBatch` по умолчанию 10
 * строк за тик раз в 2 минуты — `configuration.ts:327-330,394,401`,
 * `catalog-batch-worker.service.ts:201,270` — до ~100 минут в худшем
 * случае) — совокупно до ~190 минут; 4 часа — круглое число с запасом.
 */
export const BATCH_COHORT_HORIZON_MS = 4 * 60 * 60 * 1000;

/**
 * Когорта считается финальной («matured»), когда с конца её окна `to`
 * прошло не меньше горизонта соответствующего воркфлоу — до этого
 * момента часть сущностей когорты физически ещё не успела дойти до
 * поздних стадий, и текущий процент конверсии может вырасти
 * (doc/WORKFLOW-FUNNEL-COHORT-CONVERSION-SPEC.md §3.2). Граница
 * включительная: `now === to + horizonMs` уже считается финальной.
 */
export function isCohortMatured(
  to: Date,
  horizonMs: number,
  now: Date = new Date(),
): boolean {
  return now.getTime() >= to.getTime() + horizonMs;
}
