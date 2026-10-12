/**
 * №113 (заход 10) — подсказки панели редактора голосовой карты «Сайта»,
 * чистая часть. Заход 13 (Р-З13-А1): само ядро — нейтральное
 * `assist-ui-core/editor-assist.ts` (общее с «Админкой»); здесь — прежние
 * имена (`EDITOR_ASSIST` с оценкой резерва бюджета обучения).
 */
import { EDITOR_ASSIST_CORE } from '../../assist-ui-core/editor-assist';
import { geminiOutputCeiling } from '../../site-ai/gemini-output';

export * from '../../assist-ui-core/editor-assist';

export const EDITOR_ASSIST = {
  ...EDITOR_ASSIST_CORE,
  /** Оценка для резерва бюджета обучения (`assist-learn`). */
  estUnits: { inputTokens: 1_200, outputTokens: geminiOutputCeiling(600) },
} as const;
