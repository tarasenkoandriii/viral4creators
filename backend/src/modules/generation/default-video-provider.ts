/**
 * «Провайдер видео-генерации по умолчанию» — какой провайдер
 * предзаполнен на экране генерации при первом открытии (§11.1 ТЗ
 * VEO-MODEL-VERSION-CHOICE-SPEC.md — «оба уровня одновременно»:
 * админ задаёт умолчание, пользователь может переопределить на
 * конкретной генерации, тот же принцип, что уже есть у `quality`).
 *
 * Найдено при аудите (§11.1 доп. запись): это решение было принято
 * ДАВНО, но админская половина никогда не была реализована — только
 * код-дефолт в `GenerationWizard.tsx` (`useState('grok')`). Этот файл
 * и `AdminVideoProviderSettingsService` закрывают именно эту
 * недостающую половину, тем же паттерном, что уже есть для озвучки
 * (`../tts/default-tts-provider.ts`, §даже раньше) и разбора
 * референса (`../analysis/default-analysis-provider.ts`, §17).
 *
 * Значение живёт в `PlatformSetting`, без переменной окружения-
 * фоллбека — так же, как у разбора видео (§17): нет предыдущего
 * `ENV`-выбора, который стенды могли уже настроить.
 */

export const VIDEO_PROVIDER_KEYS = ['grok', 'veo'] as const;

export type VideoProviderKey = (typeof VIDEO_PROVIDER_KEYS)[number];

export const DEFAULT_VIDEO_PROVIDER_SETTING_KEY = 'default_video_provider';

/**
 * `grok` — не только более дешёвый провайдер (§10.2 ТЗ) при сравнимом
 * качестве, но и держатель бОльшего запаса референс-слотов (7 против
 * 3 у Veo, §2/§15 ТЗ) — практически важно для персонажей бренда и
 * text-card одновременно (§20.5). Решено по прямому запросу сделать
 * провайдером по умолчанию.
 */
const FALLBACK_KEY: VideoProviderKey = 'grok';

export function isVideoProviderKey(
  value: string | null | undefined,
): value is VideoProviderKey {
  return (VIDEO_PROVIDER_KEYS as readonly string[]).includes(value ?? '');
}

/**
 * Чистая функция — тот же принцип, что у `resolveDefaultAnalysisProvider`:
 * без обращения к БД внутри, мягкий откат на невалидном значении, не
 * исключение.
 */
export function resolveDefaultVideoProvider(
  stored: string | null | undefined,
): VideoProviderKey {
  if (isVideoProviderKey(stored)) return stored;
  return FALLBACK_KEY;
}
