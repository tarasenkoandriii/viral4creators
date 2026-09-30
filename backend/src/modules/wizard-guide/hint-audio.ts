/**
 * Голос советника — чистые правила (ТЗ
 * docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md §4А.4, этап K1).
 *
 * Здесь то, что проверяется без базы и сети: какой голос у помощника,
 * по какому ключу лежит озвучка и можно ли эту реплику произносить в
 * регистре повода. Сервис (`hint-audio.service.ts`) только читает и
 * пишет.
 */

import { createHash } from 'crypto';
import {
  EXPLICIT_TTS_PROVIDER_KEYS,
  type ExplicitTtsProviderKey,
} from '../tts/default-tts-provider';
import { textFitsRegister } from '../../common/greeting-policy';
import type { GreetingRegister } from '../../common/types/greeting.types';
import { isSupportedLocale, type SupportedLocale } from '../../common/locale';

/**
 * Настройка админки: пресет голоса помощника, JSON
 * `{ "provider": "soniox", "voiceId": "Maya" }`. UI — у админки (этап K3).
 */
export const VOICE_ASSISTANT_VOICE_KEY = 'voice_assistant_voice';

export interface AssistantVoice {
  provider: ExplicitTtsProviderKey;
  /** `null` — голос провайдера по умолчанию. */
  voiceId: string | null;
}

/**
 * Умолчание — Soniox.
 *
 * Из трёх настоящих провайдеров он единственный, у которого разом есть
 * и русский с украинским, и голос по умолчанию: у Resemble голоса по
 * умолчанию нет (синтез без выбранного голоса пропускается), и по
 * прайсу проекта (`ai-pricing.ts`) Soniox дешевле обоих: $14 за миллион
 * символов против $33 у Resemble и $220 у ElevenLabs. xAI не
 * подходит вовсе: его голоса живут внутри видеомодели и отдельным файлом
 * не синтезируются, а украинского у него нет.
 *
 * Голос помощника — ОТДЕЛЬНЫЙ пресет (В-11), а не «Озвучка по
 * умолчанию»: та выбирается под ролики и счёт за них, и смена её ради
 * роликов не должна молча менять голос, которым мастер разговаривает с
 * человеком.
 */
export const DEFAULT_ASSISTANT_VOICE: AssistantVoice = {
  provider: 'soniox',
  voiceId: null,
};

/**
 * Разбор настройки. Кривая строка, незнакомый провайдер, `veo`
 * («не озвучивать») — умолчание, а не исключение: настройку правит
 * человек руками, и опечатка в ней не должна ронять мастер.
 */
export function parseAssistantVoice(
  raw: string | null | undefined,
): AssistantVoice {
  if (!raw?.trim()) return DEFAULT_ASSISTANT_VOICE;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_ASSISTANT_VOICE;
  }
  if (!parsed || typeof parsed !== 'object') return DEFAULT_ASSISTANT_VOICE;
  const { provider, voiceId } = parsed as {
    provider?: unknown;
    voiceId?: unknown;
  };
  if (
    typeof provider !== 'string' ||
    !(EXPLICIT_TTS_PROVIDER_KEYS as readonly string[]).includes(provider)
  ) {
    return DEFAULT_ASSISTANT_VOICE;
  }
  return {
    provider: provider as ExplicitTtsProviderKey,
    voiceId:
      typeof voiceId === 'string' && voiceId.trim() ? voiceId.trim() : null,
  };
}

/**
 * Ключ озвучки: подсказка + провайдер + РАЗРЕШЁННЫЙ голос + язык + САМ
 * ТЕКСТ.
 *
 * Голос — тот, которым провайдер действительно заговорит: из настройки
 * или, если там пусто, его голос по умолчанию со стенда
 * (`TtsProvider.defaultVoice`). Не «default»: сменили голос по умолчанию
 * в окружении — старая озвучка обязана перестать отдаваться (аудит
 * волны 1).
 *
 * Текст входит в ключ потому, что строка кеша подсказки по истечении
 * суток переписывается свежим ответом модели под ТЕМ ЖЕ ключом (см.
 * `WizardHintService.remember`). Без текста в ключе озвучка вчерашней
 * реплики звучала бы под сегодняшней строкой на экране.
 */
export function hintAudioKey(parts: {
  hintKey: string;
  provider: string;
  voiceId: string;
  lang: string;
  text: string;
}): string {
  return createHash('sha256')
    .update(
      [
        parts.hintKey,
        parts.provider,
        parts.voiceId,
        parts.lang,
        parts.text,
      ].join('\u0000'),
    )
    .digest('hex');
}

/**
 * Язык подсказки — из её ключа (`scenario|stepId|locale|…`,
 * `hintCacheKey`), а не из запроса клиента.
 *
 * Текст подсказки написан на языке, который стоит в ключе; язык из
 * запроса мог бы с ним разойтись — и тогда русский текст ушёл бы в
 * синтез как английский, а одна подсказка синтезировалась бы пять раз,
 * по разу на каждый `lang` (аудит волны 1). `null` — ключ не нашего
 * вида.
 */
export function hintKeyLocale(hintKey: string): SupportedLocale | null {
  const locale = hintKey.split('|')[2];
  return isSupportedLocale(locale) ? locale : null;
}

/**
 * Путь файла в Blob. Префикс общий на все проекты: озвучка подсказки —
 * такое же общее достояние, как сам кеш подсказок, и не принадлежит
 * ни проекту, ни сессии (поэтому метла `sweep-orphans` её не видит).
 */
export const HINT_AUDIO_PREFIX = 'wizard-hint-audio/';

export function hintAudioPathname(audioKey: string, mimeType: string): string {
  const ext = mimeType.includes('wav')
    ? 'wav'
    : mimeType.includes('ogg')
      ? 'ogg'
      : 'mp3';
  return `${HINT_AUDIO_PREFIX}${audioKey}.${ext}`;
}

/**
 * Ключ подсказки принадлежит сценарию проекта.
 *
 * Ключ приходит от клиента, и без этой проверки маршрут озвучки одного
 * проекта годился бы для озвучки подсказок любого сценария. Подсказки
 * при этом наши, а не чужие, но платит за синтез человек из своего
 * потолка голоса — пусть платит только за свой мастер.
 */
export function hintKeyBelongsTo(hintKey: string, scenario: string): boolean {
  return hintKey.startsWith(`${scenario}|`);
}

/**
 * Можно ли произносить реплику в этом регистре (§3.7, §4А.4).
 *
 * `null` — регистр неизвестен (не поздравление или бриф ещё не
 * сохранён): ограничений нет, как у праздничного повода. Не прошла —
 * реплика остаётся на экране текстом, но не звучит: бодрое «Отлично!»
 * вслух на экране соболезнования хуже тишины.
 */
export function mayVoiceInRegister(
  register: GreetingRegister | null,
  text: string,
): boolean {
  if (!register) return true;
  return textFitsRegister(register, text);
}
