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

/**
 * Реплика диктора к кадру этого шага (§3-бис.2 ТЗ
 * docs-tz/TZ-Tutorial-Video-Voiced.md, этап D) — одна фраза, которую
 * произносят, пока на экране результат ЭТОГО шага.
 *
 * **Необязательное, и это не осторожность.** `parseScenarioSteps`
 * валидирует всё-или-ничего: одно несоответствие роняет ВЕСЬ
 * сценарий. Сделать поле обязательным значило бы, что в момент
 * деплоя каждый уже сохранённый сценарий становится невалидным, а
 * вместе с ним отваливается регрессионный прогон, который к озвучке
 * отношения не имеет. Отсутствует — работает запасной путь, вариант А
 * (`narrationTextForSubject`): одна дорожка из карточки шага
 * обучалки. Он остаётся навсегда, а не до первой генерации.
 *
 * У `triggerPaidOperation` реплики нет: это декларативный маркер,
 * произносить нечего. Но КАДР у него есть (шаг — no-op, который
 * успешно возвращается, и общий цикл безусловно делает скриншот), и
 * путать «реплики нет» с «кадра нет» нельзя: такой кадр получает
 * `MIN_FRAME_SECONDS` и тишину, а не выпадает.
 */
export interface ScenarioStepNarration {
  narration?: string;
}

export interface ScenarioStepGoto extends ScenarioStepNarration {
  kind: 'goto';
  /** route.name из frontend/src/lib/router.ts (см. §2.4 ТЗ), не URL. */
  route: string;
}

export interface ScenarioStepFill extends ScenarioStepNarration {
  kind: 'fill';
  selector: string;
  value: string;
}

export interface ScenarioStepClick extends ScenarioStepNarration {
  kind: 'click';
  selector: string;
}

export interface ScenarioStepWaitFor extends ScenarioStepNarration {
  kind: 'waitFor';
  selector: string;
}

export interface ScenarioStepAssertVisible extends ScenarioStepNarration {
  kind: 'assertVisible';
  selector: string;
}

export interface ScenarioStepAssertText extends ScenarioStepNarration {
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

/**
 * Платные операции, которые ЭКРАН МАСТЕРА вообще способен запустить, —
 * то, что модели разрешено написать в `triggerPaidOperation.operation`.
 *
 * Один список на две стороны: его перечисляет промпт генератора
 * (`tutorial-scenario-prompt.ts`) и по нему же отказывает валидатор
 * (`scenario-steps.ts`). До этапа F (ТЗ docs-tz/TZ-Tutorial-Video-
 * Voiced.md) стороны жили порознь: промпт называл пять значений руками,
 * а валидатор принимал ЛЮБОЙ ключ `AI_OPERATION_LABEL` — сорок с
 * лишним строк отчёта расходов, включая фоновые, которых мастер не
 * запускает никогда (`tutorial-video-assembly`, `blog-analysis`,
 * `assistant`). Каждая новая строка отчёта молча становилась словом,
 * которое модели позволено сказать; этап F добавлял
 * `tutorial-voiceover` — то есть позволил бы сценарию объявить платной
 * озвучку самой обучалки, у которой нет ни кнопки, ни экрана.
 *
 * Отсюда и форма: явный перечень, а не «всё, кроме». Новая строка
 * отчёта расходов сюда НЕ попадает сама — её надо вписать, и это
 * решение про мастер, а не про бухгалтерию.
 */
export const WIZARD_PAID_OPERATIONS = [
  'generation',
  'voiceover',
  'voiceover-preview',
  'voice-clone',
  'avatar-generation',
] as const satisfies readonly AiOperation[];

export type WizardPaidOperation = (typeof WIZARD_PAID_OPERATIONS)[number];

export interface ScenarioStepTriggerPaidOperation {
  kind: 'triggerPaidOperation';
  /** Та же операция, что попала бы в AiUsageService.record() при реальном
   *  исполнении, — но только из тех, что мастер умеет запустить. */
  operation: WizardPaidOperation;
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

/**
 * Потолок длины реплики (§3-бис.2 ТЗ).
 *
 * 220 символов ≈ 15 секунд речи. Длиннее — кадр висит слишком долго,
 * и это уже не подпись к действию, а лекция: зритель смотрит на
 * неподвижный скриншот четверть минуты. Число живёт здесь, рядом с
 * контрактом, и его читают обе стороны — валидатор и промпт, — чтобы
 * «до 220 символов» в инструкции модели и отказ валидатора не
 * разошлись.
 */
export const MAX_NARRATION_LENGTH = 220;

/** Реплика у шага, если она есть и годна. Читается и исполнителем, и
 *  админкой; `triggerPaidOperation` сюда не попадает по построению —
 *  у его типа поля нет. */
export function narrationOf(step: ScenarioStep): string | null {
  if (step.kind === 'triggerPaidOperation') return null;
  const text = step.narration?.trim() ?? '';
  return text.length > 0 ? text : null;
}
