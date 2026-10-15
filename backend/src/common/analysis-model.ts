import { GEMINI_MODEL } from './gemini-model';

export const ANALYSIS_MODEL_SETTING = 'analysis.geminiModel';
export const ANALYSIS_MODELS = [
  ...new Set([
    GEMINI_MODEL,
    'gemini-3.6-flash',
    'gemini-3.8-flash',
    'gemini-4-argon',
  ]),
];
export function resolveAnalysisModel(value: string | null | undefined): string {
  return value && ANALYSIS_MODELS.includes(value) ? value : GEMINI_MODEL;
}
/** Preserve existing default-model library entries; isolate other models. */
export function analysisModelCacheKey(key: string, model: string): string;
export function analysisModelCacheKey(
  key: string | null,
  model: string,
): string | null;
export function analysisModelCacheKey(
  key: string | null,
  model: string,
): string | null {
  return key === null || model === GEMINI_MODEL ? key : `${key}:model:${model}`;
}
