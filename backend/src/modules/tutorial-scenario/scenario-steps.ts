/**
 * Валидация словаря шагов сценария (scenario-steps.types.ts, §4.10 ТЗ).
 *
 * Отличие от `assistant/actions.ts` (тоже парсит JSON от модели по
 * белому списку): там невалидный ПУНКТ списка просто выбрасывается —
 * кнопка необязательна, посетитель и так получил текстовый ответ. Здесь
 * НАОБОРОТ: один невалидный шаг роняет ВЕСЬ сценарий. Причина —
 * порядок шагов имеет смысл (`goto` → `fill` → `click` → `waitFor`), и
 * молча выбросить шаг из середины даёт сценарий, который выглядит
 * рабочим, но на самом деле пропускает действие — хуже, чем явно
 * отказаться от генерации в этом прогоне и попробовать в следующий раз.
 */

import { AI_OPERATION_LABEL } from '../../common/ai-pricing';
import {
  MAX_SCENARIO_STEPS,
  ScenarioStep,
  SCENARIO_STEP_KINDS,
} from './scenario-steps.types';

const VALID_OPERATIONS = new Set(Object.keys(AI_OPERATION_LABEL));

/** Непустая строка разумной длины — общая проверка для selector/route/value. */
function isNonEmptyString(v: unknown, maxLen = 500): v is string {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= maxLen;
}

function isValidScenarioStep(value: unknown): value is ScenarioStep {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (
    typeof v.kind !== 'string' ||
    !SCENARIO_STEP_KINDS.includes(v.kind as ScenarioStep['kind'])
  ) {
    return false;
  }
  switch (v.kind as ScenarioStep['kind']) {
    case 'goto':
      return isNonEmptyString(v.route, 200);
    case 'fill':
      return (
        isNonEmptyString(v.selector, 200) &&
        typeof v.value === 'string' &&
        v.value.length <= 2000
      );
    case 'click':
    case 'waitFor':
    case 'assertVisible':
      return isNonEmptyString(v.selector, 200);
    case 'assertText':
      return (
        isNonEmptyString(v.selector, 200) && isNonEmptyString(v.value, 2000)
      );
    case 'triggerPaidOperation': {
      if (
        typeof v.operation !== 'string' ||
        !VALID_OPERATIONS.has(v.operation)
      ) {
        return false;
      }
      if (!isNonEmptyString(v.model, 100)) return false;
      if (!isNonEmptyString(v.note, 300)) return false;
      const units = v.expectedUnits;
      if (!units || typeof units !== 'object') return false;
      const u = units as Record<string, unknown>;
      const numOrUndefined = (x: unknown) =>
        x === undefined ||
        (typeof x === 'number' && x >= 0 && Number.isFinite(x));
      // Найдено доп. аудитом (MEDIUM): раньше `expectedUnits: {}` (все
      // три поля отсутствуют — опечатка в ключе или модель просто ничего
      // не заполнила) проходила валидацию, потому что `numOrUndefined`
      // принимает `undefined`. Для известной (найденной в MODEL_RATES)
      // модели `estimateCost(model, {})` тогда возвращает
      // `unpriced: false, costMicroUsd: 0` — уверенно показанный ноль,
      // а не помеченная недостоверной оценка, хотя доверять ему нечего.
      // `costly: true` всё равно остаётся верным (считается по наличию
      // самого шага, не по цене), so будущий драйвер исполнения (§5) не
      // обходит одобрение — но сумма, на основании которой оператор
      // одобряет трату, лжёт. Требуем хотя бы одну единицу объёма.
      return (
        (u.seconds !== undefined ||
          u.characters !== undefined ||
          u.calls !== undefined) &&
        numOrUndefined(u.seconds) &&
        numOrUndefined(u.characters) &&
        numOrUndefined(u.calls)
      );
    }
    default:
      return false;
  }
}

export interface ParseScenarioResult {
  ok: boolean;
  steps: ScenarioStep[];
  /** Причина отказа — для лога генератора, не показывается пользователю нигде. */
  reason?: string;
}

/**
 * Разбирает и строго валидирует массив шагов. В отличие от
 * `actions.ts:parseActions` — все-или-ничего (см. доккомментарий файла):
 * первый же невалидный шаг или пустой/переполненный список — весь
 * сценарий отбрасывается, `ok: false`.
 */
export function parseScenarioSteps(raw: unknown): ParseScenarioResult {
  if (!Array.isArray(raw)) {
    return { ok: false, steps: [], reason: 'steps не массив' };
  }
  if (raw.length === 0) {
    return { ok: false, steps: [], reason: 'пустой сценарий' };
  }
  if (raw.length > MAX_SCENARIO_STEPS) {
    return {
      ok: false,
      steps: [],
      reason: `слишком много шагов (${raw.length} > ${MAX_SCENARIO_STEPS})`,
    };
  }
  const steps: ScenarioStep[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!isValidScenarioStep(item)) {
      return { ok: false, steps: [], reason: `шаг ${i + 1} невалиден` };
    }
    steps.push(item);
  }
  return { ok: true, steps };
}

export function isTriggerPaidOperationStep(
  step: ScenarioStep,
): step is Extract<ScenarioStep, { kind: 'triggerPaidOperation' }> {
  return step.kind === 'triggerPaidOperation';
}
