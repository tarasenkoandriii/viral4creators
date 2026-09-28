/**
 * Прикидка стоимости сценария (§4.11 ТЗ) — не новое изобретение, а
 * вызов уже существующей чистой функции `estimateCost()`
 * (`common/ai-pricing.ts`) на единицах, которые сам сценарий
 * задекларировал в своих `triggerPaidOperation`-шагах. Та же функция,
 * которой считает и вкладка «Расходы», и `AiUsageService.record()` при
 * реальном вызове — прикидка и факт совпадают методом, а не только
 * числом совпадения ради.
 *
 * Одно отличие от общей функции сознательное: здесь НОЛЬ у платного
 * шага считается отсутствием прикидки, а не суммой. В общем счётчике
 * расходов ноль бывает законным (бесплатный вызов), а у шага, который
 * сам объявил себя платным, — нет. См. ниже.
 */

import { estimateCost } from '../../common/ai-pricing';
import { isTriggerPaidOperationStep } from './scenario-steps';
import { ScenarioStep } from './scenario-steps.types';

export interface ScenarioCostEstimate {
  costly: boolean;
  /** null, если costly=false — «бесплатный» сценарий не носит сумму вовсе, не ноль. */
  estimatedCostMicroUsd: number | null;
  /** true, если хотя бы для одной модели среди платных шагов не нашлось ставки в прайсе — сумма выше в этом случае занижена. */
  unpriced: boolean;
}

export function estimateScenarioCost(
  steps: ScenarioStep[],
): ScenarioCostEstimate {
  const paidSteps = steps.filter(isTriggerPaidOperationStep);
  if (paidSteps.length === 0) {
    return { costly: false, estimatedCostMicroUsd: null, unpriced: false };
  }
  let totalMicroUsd = 0;
  let unpriced = false;
  for (const step of paidSteps) {
    const estimate = estimateCost(step.model, step.expectedUnits);
    // Ноль у ОБЪЯВЛЕННОГО платного шага — всегда признак того, что
    // прикидку не на чем построить, даже когда прайс формально ответил
    // (находка сквозного аудита 29.09.2026).
    //
    // `estimateCost` возвращает `unpriced: true` только когда модели
    // нет в прайсе вовсе. Но ставка складывается по единицам, и
    // несовпадение единиц даёт тихий ноль с `unpriced: false`: у всех
    // видеомоделей есть `perSecond` и нет `perCall`, а валидатор
    // (`scenario-steps.ts`) считает достаточным ЛЮБУЮ одну единицу из
    // трёх — то есть `expectedUnits: {calls: 1}` проходит проверку и
    // оценивается в $0.0000 без единой пометки. Оператор одобряет
    // уверенный ноль, а платит настоящий рендер.
    //
    // Шаг объявил платный вызов сам; значит ноль — не ответ, а
    // отсутствие ответа. Помечаем, не пытаясь угадать сумму: подпись
    // «прикидка занижена» рядом с $0.0000 честнее любого домысла.
    if (estimate.unpriced || estimate.costMicroUsd === 0) unpriced = true;
    totalMicroUsd += estimate.costMicroUsd;
  }
  return { costly: true, estimatedCostMicroUsd: totalMicroUsd, unpriced };
}
