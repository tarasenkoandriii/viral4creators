/**
 * «Озвучка по умолчанию» — какой провайдер синтеза активен, когда
 * бренд заказал `voiceMode: 'voiceover' | 'dub'` (§15.1 SPEC) и не
 * привязан жёстко к конкретному провайдеру. Три пункта селектора в
 * админке:
 *
 * - `elevenlabs` / `resemble` — настоящие провайдеры синтеза
 *   (`ElevenLabsService`/`ResembleService`), тарифицируются по счёту у
 *   поставщика и могут отказать, если на балансе аккаунта нет денег.
 * - `veo` — не провайдер синтеза, а явный выбор «не пытаться»:
 *   `VeoPassthroughService` всегда отвечает «не настроено», и ролик
 *   остаётся со звуком, который синтезировала сама Veo при рендере —
 *   тот же путь, что и «ключ ElevenLabs не задан» до этой фичи. Задать
 *   его администратор может ЗАРАНЕЕ, когда известно, что баланс обеих
 *   платных студий пуст — вместо того, чтобы каждый ролик отдельно
 *   долетал до провайдера, получал отказ и лишь тогда откатывался.
 *
 * Значение живёт в `PlatformSetting` (админка, без редеплоя) с
 * фоллбеком на переменную окружения `TTS_PROVIDER` (старое поведение,
 * этап 70) для стендов, которые ни разу не трогали этот селектор —
 * задать её кто-то мог до появления этой фичи, и тихо забыть про неё
 * значило бы откатить выбор оператора.
 */

export const VOICEOVER_PROVIDER_KEYS = [
  'elevenlabs',
  'resemble',
  'veo',
] as const;

export type VoiceoverProviderKey = (typeof VOICEOVER_PROVIDER_KEYS)[number];

/** Ключ записи в `PlatformSetting` — здесь, а не расфасовано по вызовам. */
export const DEFAULT_VOICEOVER_PROVIDER_SETTING_KEY =
  'default_voiceover_provider';

/** Тот же дефолт, что был у `TTS_PROVIDER` до этой фичи (этап 70) — менять
 * умолчание для стендов, которые ничего не настраивали, не повод. */
const FALLBACK_KEY: VoiceoverProviderKey = 'elevenlabs';

export function isVoiceoverProviderKey(
  value: string | null | undefined,
): value is VoiceoverProviderKey {
  return (VOICEOVER_PROVIDER_KEYS as readonly string[]).includes(value ?? '');
}

/**
 * Подмножество `VOICEOVER_PROVIDER_KEYS` БЕЗ `'veo'` — настоящие
 * провайдеры синтеза, которые имеет смысл выбирать явно ДЛЯ ОДНОЙ
 * СЕССИИ (этап 91: `UpdateBrandSnapshotRequestDto.ttsProvider`,
 * `RevoicePanel`). `'veo'` сюда не входит намеренно: это не провайдер,
 * а «не озвучивать вовсе» — тег `ttsProvider: 'veo'` на голосе с
 * непустым `ttsVoiceId` привёл бы `postprod.service.ts` к
 * гарантированному отказу синтеза (`VeoPassthroughService` всегда
 * `skipped: true`), то есть к обречённому платному вызову переозвучки
 * — том самом, от чего вся эта проверка изначально защищала.
 */
export const EXPLICIT_TTS_PROVIDER_KEYS = ['elevenlabs', 'resemble'] as const;

export type ExplicitTtsProviderKey =
  (typeof EXPLICIT_TTS_PROVIDER_KEYS)[number];

/**
 * Чистая функция — сознательно без обращения к `process.env` или БД
 * внутри, чтобы юнит-тесты не мокали ни то, ни другое. Порядок:
 * значение из админки (если валидно) → `TTS_PROVIDER` из окружения
 * (если валидно) → `elevenlabs`. Невалидное/неизвестное значение на
 * любом из первых двух шагов пропускается молча, а не бросает
 * исключение — тот же принцип мягкого отката, что у самих провайдеров
 * (см. elevenlabs.service.ts, шапка).
 */
export function resolveDefaultProviderKey(
  stored: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): VoiceoverProviderKey {
  if (isVoiceoverProviderKey(stored)) return stored;
  const fromEnv = env.TTS_PROVIDER?.trim().toLowerCase();
  if (isVoiceoverProviderKey(fromEnv)) return fromEnv;
  return FALLBACK_KEY;
}
