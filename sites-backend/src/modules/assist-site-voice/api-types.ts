/**
 * Протокол голоса Э5 — стык сервера с iframe-чатом (widget/src/chat/api.ts,
 * widget/src/voice/*) и TMA (assist/src/lib/voice-types.ts повторяет типы).
 * Менять — вместе с ними.
 */
import type { VoiceOffReason } from './public/voice-access';
import type { VoiceConfig } from './voice-config';

export type { VoiceConfig, VoiceOffReason };

/** GET /widget/v1/config → `voice` (необязательное: кэш 5 мин и старые загрузчики). */
export interface WidgetVoiceConfig {
  /** Кнопка микрофона (push-to-talk). */
  input: boolean;
  /** Кнопка «озвучить ответ». */
  output: boolean;
  /** Потолок записи, мс (§4.10: 30 с). */
  maxRecordMs: number;
  /** Фраза короче — отбрасывается на устройстве (§5-бис.7: 0.4 с). */
  minSpeechMs: number;
  /** Тишина, которая заканчивает фразу (§5-бис.7: ~1 с). */
  endSilenceMs: number;
}

/**
 * POST /widget/v1/voice — тело: запись (`Content-Type: audio/*`, ≤ 1 МБ),
 * заголовок visitor-token. Ответ — распознанный текст; iframe показывает его
 * («я услышал: …») и шлёт обычным `POST /widget/v1/chat` с `voiceTicket`.
 */
export interface WidgetVoiceResponse {
  text: string;
  /** Язык речи по провайдеру (uk/ru/en/…); null — не определён. */
  lang: string | null;
  /** Подпись «распознано у нас» — диалог весом 2 (§7.1); null — нет ключа. */
  voiceTicket: string | null;
}

/** POST /widget/v1/tts — тело `{ messageId }`; ответ — байты `audio/mpeg`. */
export interface WidgetTtsRequest {
  messageId: string;
}

/** Кабинет: GET /assist/sites/:id/voice-config */
export interface VoiceSettingsView {
  siteId: string;
  config: VoiceConfig;
  /** Тариф и платформа позволяют включить голос. */
  available: boolean;
  /** Почему голос сейчас не работает у посетителей (null — работает). */
  reason: VoiceOffReason | null;
  /** Голоса провайдера (пусто — ключа нет или справочник не ответил). */
  voices: Array<{
    id: string;
    gender: string | null;
    description: string | null;
  }>;
  defaultVoice: string;
  /** Суточный потолок голоса сайта и потрачено сегодня (UTC), микродоллары. */
  dailyCapMicroUsd: number;
  todaySpentMicroUsd: number;
}

/** Кабинет: POST /assist/sites/:id/voice-config/sample — тело. */
export interface VoiceSampleRequest {
  voiceId?: string | null;
  lang?: 'uk' | 'ru' | 'en';
}

/** Ответ примера голоса: короткая фраза mp3 в base64 (обычный конверт). */
export interface VoiceSampleResponse {
  mime: string;
  dataBase64: string;
}

export const VOICE_CABINET_ERROR_CODES = [
  'VOICE_CONFIG_INVALID',
  'VOICE_PLAN_REQUIRED',
  'VOICE_UNAVAILABLE',
  'VOICE_LIMIT',
  'UPSTREAM',
] as const;
export type VoiceCabinetErrorCode = (typeof VOICE_CABINET_ERROR_CODES)[number];
