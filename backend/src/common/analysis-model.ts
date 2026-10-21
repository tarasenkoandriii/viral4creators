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
/** Unscoped library entries were created by the legacy 3.6 Flash default.
 * Never reinterpret them as Argon results when the default changes. */
const LEGACY_UNSCOPED_MODEL = 'gemini-3.6-flash';
export function analysisModelCacheKey(key: string, model: string): string;
export function analysisModelCacheKey(
  key: string | null,
  model: string,
): string | null;
export function analysisModelCacheKey(
  key: string | null,
  model: string,
): string | null {
  return key === null || model === LEGACY_UNSCOPED_MODEL
    ? key
    : `${key}:model:${model}`;
}
