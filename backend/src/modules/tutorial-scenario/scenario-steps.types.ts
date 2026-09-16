/**
 * Словарь шагов сценария (doc/TMA-UI-SNAPSHOT-AND-TUTORIAL-VIDEO-SPEC.md
 * §4.10) — ФИКСИРОВАННЫЙ набор примитивов, из которых ИИ по крону
 * `tutorial-scenario-generate` собирает сценарий для будущей автозаписи
 * обучающего видео. Это данные, а не код: сценарий никогда не
 * исполняется как JS/eval, а читается общим драйвером (§5 того же ТЗ,
 * ещё не реализован) по этому же словарю. Осознанная граница
 * безопасности — модель, которая пишет код, который сам исполняется по
 * расписанию, это прямой путь к инъекции; ограниченный словарь примитивов
 * убирает этот риск структурно, а не полагается на то, что модель ведёт
 * себя хорошо.
 *
 * `triggerPaidOperation` — единственный шаг, который сам не выполняет
 * никакого клика/ввода, а декларирует, что СЛЕДУЮЩИЙ шаг (обычно
 * `click`) запускает платную операцию (Veo/Grok рендер, ElevenLabs/
 * Resemble переозвучка) — и по какой модели/объёму её оценивать
 * (`scenario-cost.ts`, §4.11 ТЗ). Он декларативный: ничего не вызывает
 * сам, только помечает соседний шаг как небесплатный для оценки
 * стоимости ДО того, как сценарий когда-либо реально исполнится.
 */

import { AiOperation } from '../../common/ai-pricing';

export interface ScenarioStepGoto {
  kind: 'goto';
  /** route.name из frontend/src/lib/router.ts (см. §2.4 ТЗ), не URL. */
  route: string;
}

export interface ScenarioStepFill {
  kind: 'fill';
  selector: string;
  value: string;
}

export interface ScenarioStepClick {
  kind: 'click';
  selector: string;
}

export interface ScenarioStepWaitFor {
  kind: 'waitFor';
  selector: string;
}

export interface ScenarioStepAssertVisible {
  kind: 'assertVisible';
  selector: string;
}

export interface ScenarioStepAssertText {
  kind: 'assertText';
  selector: string;
  value: string;
}

/** Единицы объёма для прикидки цены (`common/ai-pricing.ts:UsageUnits`)
 * — только то подмножество полей, которое реально бывает известно
 * ЗАРАНЕЕ, до самого вызова (секунды видео, символы текста); токены
 * входа/выхода текстовой модели заранее не оцениваются. */
export interface ScenarioExpectedUnits {
  seconds?: number;
  characters?: number;
  calls?: number;
}

export interface ScenarioStepTriggerPaidOperation {
  kind: 'triggerPaidOperation';
  /** Та же операция, что попала бы в AiUsageService.record() при реальном исполнении. */
  operation: AiOperation;
  /** Ключ модели — должен найтись в MODEL_RATES (common/ai-pricing.ts), иначе оценка помечается unpriced. */
  model: string;
  expectedUnits: ScenarioExpectedUnits;
  /** Короткое человекочитаемое объяснение — «Veo, ожидаемо 40 секунд рендера» — для карточки одобрения в админке (§4.11). */
  note: string;
}

export type ScenarioStep =
  | ScenarioStepGoto
  | ScenarioStepFill
  | ScenarioStepClick
  | ScenarioStepWaitFor
  | ScenarioStepAssertVisible
  | ScenarioStepAssertText
  | ScenarioStepTriggerPaidOperation;

export const SCENARIO_STEP_KINDS: readonly ScenarioStep['kind'][] = [
  'goto',
  'fill',
  'click',
  'waitFor',
  'assertVisible',
  'assertText',
  'triggerPaidOperation',
];

/** Потолок числа шагов на сценарий — защита от абсурдно длинного/
 * зацикленного ответа модели, не архитектурное ограничение. */
export const MAX_SCENARIO_STEPS = 30;
