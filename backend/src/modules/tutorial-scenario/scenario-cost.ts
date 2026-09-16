/**
 * Прикидка стоимости сценария (§4.11 ТЗ) — не новое изобретение, а
 * вызов уже существующей чистой функции `estimateCost()`
 * (`common/ai-pricing.ts`) на единицах, которые сам сценарий
 * задекларировал в своих `triggerPaidOperation`-шагах. Та же функция,
 * которой считает и вкладка «Расходы», и `AiUsageService.record()` при
 * реальном вызове — прикидка и факт совпадают методом, а не только
 * числом совпадения ради.
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
    if (estimate.unpriced) unpriced = true;
    totalMicroUsd += estimate.costMicroUsd;
  }
  return { costly: true, estimatedCostMicroUsd: totalMicroUsd, unpriced };
}
