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
 * Умолчание — Soniox (Р-З8-14, замер §8.3 07.10.2026 на 100 ru + 100 uk
 * фразах, чисто / 20 дБ / 10 дБ): WER Soniox 2,8–3,2 % против 5–11 % у
 * Gemini, имена 100 % против 97 %, язык ответа всегда совпал (у Gemini —
 * 3 ответа по-украински на русские фразы и до 43 «не определить»), и
 * дешевле в ~17 раз. До 07.10.2026 умолчанием был Gemini — он работает
 * без нового ключа. Без `SONIOX_API_KEY` ввод не ломается: расшифровывает
 * Gemini (`VoiceTranscriptionService.recognize`), админка предупреждает.
 * Явный выбор в админке по-прежнему главнее умолчания.
 */

export const SPEECH_RECOGNITION_PROVIDER_KEYS = ['gemini', 'soniox'] as const;
export type SpeechRecognitionProviderKey =
  (typeof SPEECH_RECOGNITION_PROVIDER_KEYS)[number];

export const SPEECH_RECOGNITION_PROVIDER_SETTING_KEY =
  'speech_recognition_provider';

const FALLBACK: SpeechRecognitionProviderKey = 'soniox';

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
