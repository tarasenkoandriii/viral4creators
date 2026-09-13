/**
 * «Разбор референса по умолчанию» — какая модель анализирует загруженное
 * видео (сцены, персонажи, аудитория, продвигаемый товар) — тот же
 * ручной селектор, что уже есть для озвучки
 * (`../tts/default-tts-provider.ts`), скопирован сюда по прямому
 * запросу владельца продукта (ТЗ VEO-MODEL-VERSION-CHOICE-SPEC.md §17).
 *
 * Два пункта селектора:
 * - `gemini` — текущее, единственное поведение до этой фичи:
 *   `AnalysisService` отправляет видеофайл целиком, модель сама
 *   раскладывает его по времени.
 * - `grok` — ⚠️ ПРИБЛИЖЕНИЕ, не эквивалент (см. §17.1 ТЗ): официально
 *   подтверждено только «Image Understanding» у Grok
 *   (`docs.x.ai` — «Video Understanding» в дереве навигации нет вовсе,
 *   все упоминания видео там — про генерацию). Путь через Grok
 *   собирает несколько кадров видео и передаёт их как картинки —
 *   разбивка по времени в этом случае оценка модели по снимкам, не
 *   буквальный просмотр.
 *
 * Значение живёт в `PlatformSetting`, без переменной окружения-фоллбека
 * — в отличие от озвучки, здесь не было предыдущего `ENV`-выбора,
 * который стенды могли уже настроить, так что откатывать нечего.
 */

export const ANALYSIS_PROVIDER_KEYS = ['gemini', 'grok'] as const;

export type AnalysisProviderKey = (typeof ANALYSIS_PROVIDER_KEYS)[number];

export const DEFAULT_ANALYSIS_PROVIDER_SETTING_KEY =
  'default_analysis_provider';

const FALLBACK_KEY: AnalysisProviderKey = 'gemini';

export function isAnalysisProviderKey(
  value: string | null | undefined,
): value is AnalysisProviderKey {
  return (ANALYSIS_PROVIDER_KEYS as readonly string[]).includes(value ?? '');
}

/**
 * Чистая функция — тот же принцип, что у `resolveDefaultProviderKey`:
 * без обращения к БД внутри, мягкий откат на невалидном значении, не
 * исключение.
 */
export function resolveDefaultAnalysisProvider(
  stored: string | null | undefined,
): AnalysisProviderKey {
  if (isAnalysisProviderKey(stored)) return stored;
  return FALLBACK_KEY;
}
