/**
 * Синтез речи (ТЗ §15.3, этап 35).
 *
 * Интерфейс отделён от провайдера сознательно: голос — та часть, которую
 * бренд захочет поменять (свой клон, другой сервис, свой TTS на своём
 * железе), и переезд не должен трогать всё остальное. Провайдер обязан
 * уметь ровно одно: текст → mp3 плюс длительность.
 */

import { SubtitleAlignment } from '../../common/subtitles';

export interface SynthesisRequest {
  text: string;
  /** Голос бренда; пусто — голос по умолчанию из настроек стенда. */
  voiceId?: string | null;
  /** Модель провайдера; пусто — из настроек стенда. */
  model?: string | null;
  /** Язык реплик — некоторым провайдерам нужен явно. */
  language?: string | null;
  /**
   * Нужно ли пословное выравнивание (этап 67, субтитры для
   * voiceover/dub) — при `true` провайдер, который это умеет, зовёт
   * другой эндпойнт и кладёт результат в `SynthesisResult.alignment`.
   * Не все провайдеры это умеют — отсутствие `alignment` в успешном
   * исходе не ошибка, а «этот провайдер тайминга не даёт».
   */
  timestamps?: boolean;
}

export interface SynthesisResult {
  audio: Buffer;
  mimeType: string;
  /** Что реально ушло в счёт: символы. */
  characters: number;
  voiceId: string;
  model: string;
  /** Пословный тайминг — только если `timestamps: true` был запрошен и провайдер это умеет. */
  alignment?: SubtitleAlignment;
}

/**
 * Почему не исключение, а объединение: не настроенный TTS — штатное
 * состояние стенда, а не сбой. Разделять «не настроено» и «сломалось»
 * обязательно: первое интерфейс показывает спокойной пометкой, второе —
 * ошибкой с причиной.
 */
export type SynthesisOutcome =
  | ({ ok: true } & SynthesisResult)
  | { ok: false; skipped: true; reason: string }
  | { ok: false; skipped: false; reason: string };

export interface VoiceOption {
  voiceId: string;
  name: string;
  previewUrl: string | null;
  accent: string | null;
}

export interface TtsProvider {
  /**
   * Машинное имя провайдера ('elevenlabs' | 'resemble' | ...) —
   * doc/TTS-PROVIDER-ALTERNATIVES-SPEC.md §4.1/§4.2. Используется как
   * тег на `BrandManifest.ttsProvider` (чтобы не спутать голос от
   * одного провайдера с другим при смене `TTS_PROVIDER` на стенде) и
   * как основа ключа в `ai-pricing.ts` (`${providerKey}-tts`).
   */
  readonly providerKey: string;
  /** Настроен ли — по нему решается «пропустить» против «сломалось». */
  configured(): boolean;
  synthesize(request: SynthesisRequest): Promise<SynthesisOutcome>;
  /** Каталог голосов для выбора в манифесте бренда. */
  voices(language?: string): Promise<{ voices: VoiceOption[]; error?: string }>;
}
