/**
 * «Распознавание речи» — какой провайдер расшифровывает голосовой ввод
 * продукта: диктовку описания товара и реплики мастера поздравления.
 * Решение владельца 29.09.2026: Soniox — вариант рядом с Gemini, выбор в
 * админке, без передеплоя.
 *
 * Тот же приём, что у «Озвучки по умолчанию» (`modules/tts/
 * default-tts-provider.ts`): значение в `PlatformSetting`, чистая функция
 * решает, что активно, неизвестное значение молча откатывается.
 *
 * Умолчание — Gemini, а не Soniox, хотя качество ru/uk у Soniox выше:
 * Gemini работает на стенде без единого нового ключа, а выбор, который
 * требует ключа, должен быть сделан человеком, а не кодом.
 */

export const SPEECH_RECOGNITION_PROVIDER_KEYS = ['gemini', 'soniox'] as const;
export type SpeechRecognitionProviderKey =
  (typeof SPEECH_RECOGNITION_PROVIDER_KEYS)[number];

export const SPEECH_RECOGNITION_PROVIDER_SETTING_KEY =
  'speech_recognition_provider';

const FALLBACK: SpeechRecognitionProviderKey = 'gemini';

export function isSpeechRecognitionProviderKey(
  value: string | null | undefined,
): value is SpeechRecognitionProviderKey {
  return (SPEECH_RECOGNITION_PROVIDER_KEYS as readonly string[]).includes(
    value ?? '',
  );
}

export function resolveSpeechRecognitionProvider(
  stored: string | null | undefined,
): SpeechRecognitionProviderKey {
  return isSpeechRecognitionProviderKey(stored) ? stored : FALLBACK;
}
