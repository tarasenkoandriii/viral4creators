/**
 * AI Publisher — состав оцениваемой конфигурации AI (P-B2, проектный
 * документ §6.7, §12.4, §12.6; Р-PUB-20).
 *
 * Конфигурация = провайдер + модель + версии инструкций ЧЕТЫРЁХ допущенных
 * генераторов + версия набора схем + правила контекста + версия набора
 * задач + ПАРАМЕТРЫ ВЫЗОВА (предаудит D2-04: температура, JSON, видимый
 * потолок вывода каждого генератора, запас на размышления, бюджет
 * размышлений); `configHash` — sha256 канонического JSON всего
 * перечисленного. Параметры не хранятся колонкой (схема не меняется): их
 * фиксирует hash, протокол прогона (`run.totals.callParams`) и журнал
 * вызова (аудит `create`, `meta.params`). Шлюз сверяет hash привязанной
 * конфигурации с hash текущего кода для её модели — смена параметров
 * закрывает `ai_use` до повторного прогона.
 * Любая смена (модель, текст инструкции → новая версия, правила контекста)
 * даёт новую конфигурацию со статусом `not_run`: привязка рабочего
 * продукта к прежней перестаёт подходить вызову (гейт сверяет модель и
 * версию инструкции), нужен повторный прогон всего набора (ТЗ §28).
 *
 * Чистый модуль.
 */
import {
  CONTEXT_RULES_VERSION,
  EVAL_SET_VERSION,
  P0_ENABLED_GENERATORS,
} from '../contracts/ai';
import { GEMINI_THINKING_HEADROOM } from '../../site-ai/gemini-output';
import { canonicalJson, sha256Hex } from '../core/content-hash';
import { GENERATORS } from './generators';
import { INSTRUCTIONS } from './instructions';

/** Температура всех генераторов (§12.1). */
export const AI_TEMPERATURE = 0.2;

/** Параметры вызова модели — часть конфигурации (предаудит D2-04). */
export interface AiCallParams {
  temperature: number;
  json: true;
  /** Видимый потолок вывода по генератору (провайдеру — + запас). */
  maxOutputTokens: Record<string, number>;
  /** Запас на размышления сверх видимого (`geminiOutputCeiling`). */
  thinkingHeadroom: number;
  /**
   * Бюджет размышлений: клиент `site-ai/text-model` его не задаёт —
   * умолчание провайдера для модели (записано явно; смена — новая
   * конфигурация).
   */
  thinkingBudget: 'provider_default';
}

export function currentCallParams(): AiCallParams {
  return {
    temperature: AI_TEMPERATURE,
    json: true,
    maxOutputTokens: Object.fromEntries(
      P0_ENABLED_GENERATORS.map((g) => [g, GENERATORS[g].maxOutputTokens]),
    ),
    thinkingHeadroom: GEMINI_THINKING_HEADROOM,
    thinkingBudget: 'provider_default',
  };
}

/** Версия набора строгих схем ответа (`contracts/ai-schemas.ts`). */
export const SCHEMA_SET_VERSION = 'schemas@1';

export interface AiConfigSpec {
  provider: string;
  model: string;
  contextRulesVersion: string;
  schemaSetVersion: string;
  instructionVersions: Record<string, string>;
  coveredGenerators: string[];
  evalSetVersion: string;
  callParams: AiCallParams;
}

/** Конфигурация текущего кода для модели (P0: четыре генератора совместно). */
export function currentConfigSpec(
  provider: string,
  model: string,
): AiConfigSpec {
  return {
    provider,
    model,
    contextRulesVersion: CONTEXT_RULES_VERSION,
    schemaSetVersion: SCHEMA_SET_VERSION,
    instructionVersions: Object.fromEntries(
      P0_ENABLED_GENERATORS.map((g) => [g, INSTRUCTIONS[g].version]),
    ),
    coveredGenerators: [...P0_ENABLED_GENERATORS],
    evalSetVersion: EVAL_SET_VERSION,
    callParams: currentCallParams(),
  };
}

export function configHashOf(spec: AiConfigSpec): string {
  return sha256Hex(
    canonicalJson({
      ...spec,
      coveredGenerators: [...spec.coveredGenerators].sort(),
    }),
  );
}
