/**
 * Голос Soniox у отправителя поздравления (S2) — общие правила для всех,
 * кто читает выбор: сценарий (строка сцены), рендер Grok
 * (`generateAudio`), постобработка (`planWork`) и говорящий аватар
 * (`avatarVoiceChoice`).
 *
 * Одна функция на все четыре места, а не четыре копии условия: если
 * сцена попросит «ведущий молчит», а постобработка решит, что
 * озвучивать нечего (или наоборот), ролик выйдет немым или с двумя
 * речами — ровно те поломки, от которых уходили у клона и пресета.
 */

import type { GreetingBriefSnapshot } from './types/greeting.types';
import {
  GREETING_ERROR_CODES,
  GreetingErrorBody,
  greetingError,
} from './greeting-errors';
import type { VoiceMode } from './voice-mode';
import { usesOwnVoice } from './voice-mode';

/**
 * Похоже ли на идентификатор голоса каталога Soniox («Maya», «Adrian»).
 * Проверка формы, не существования: строка идёт в запрос провайдеру и
 * на экран, а сверка с каталогом — отдельно (`GreetingVoiceService`).
 */
export const SONIOX_VOICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/;

/** Выбран ли голос Soniox (в том числе «голос Soniox по умолчанию»). */
export function sonioxVoiceChosen(
  brief: Pick<GreetingBriefSnapshot, 'sonioxVoice'> | null | undefined,
): boolean {
  return !!brief?.sonioxVoice;
}

/**
 * Режим звука ролика с учётом голоса Soniox.
 *
 * Явно выбранный голос Soniox звучит всегда — даже если бренд-бук
 * сессии в режиме 'veo' («свой голос не участвует»): человек выбрал
 * голос на экране поздравления, и молча проигнорировать этот выбор
 * из-за настройки серии было бы хуже, чем озвучить. Режимы со своим
 * голосом ('voiceover'/'dub') оставляем как есть — они и так озвучат.
 */
export function greetingVoiceMode(
  brief: Pick<GreetingBriefSnapshot, 'sonioxVoice'> | null | undefined,
  brandMode: VoiceMode,
): VoiceMode {
  return sonioxVoiceChosen(brief) && !usesOwnVoice(brandMode)
    ? 'voiceover'
    : brandMode;
}

export const GREETING_SONIOX_UNAVAILABLE_MESSAGE =
  'Голоса Soniox сейчас недоступны — выберите другой голос.';
export const GREETING_SONIOX_VOICE_UNKNOWN_MESSAGE =
  'Такого голоса Soniox нет — выберите голос из списка.';

/** Что нужно от провайдера Soniox (структурно — `TtsProvider`). */
export interface SonioxTtsLike {
  configured(): boolean;
  voices(
    language?: string,
  ): Promise<{ voices: ReadonlyArray<{ voiceId: string }>; error?: string }>;
}

/**
 * Звучит ли в ролике голос Soniox отправителя: клон и пресет его
 * перебивают (старая запись с двумя полями) — тот же порядок, что у
 * `avatarVoiceChoice` и `PostProductionService.planWork`.
 */
export function sonioxVoiceSounds(
  brief:
    | Pick<
        GreetingBriefSnapshot,
        'sonioxVoice' | 'senderVoice' | 'presetVoiceId'
      >
    | null
    | undefined,
): boolean {
  return (
    !!brief?.sonioxVoice &&
    !brief.senderVoice?.resembleVoiceId &&
    !brief.presetVoiceId?.trim()
  );
}

/**
 * Проверка голоса Soniox у денег (аудит S2): Grok при Soniox снимает БЕЗ
 * звука, а сбой синтеза в постобработке — не отказ, а «ухудшение»
 * (`voiceStatus: 'failed'`). Без этой проверки снятый ключ или голос,
 * убранный из каталога после выбора, давали немой ролик за полный кредит.
 *
 * - Нет ключа — отказ.
 * - Названный голос сверяется с каталогом; каталог прочитан, а голоса в
 *   нём нет — отказ.
 * - Каталог НЕ прочитан (сбой сети, ответ не 2xx) — пропускаем, как при
 *   выборе: минутный сбой справочника не должен запрещать рендер голосом,
 *   который, скорее всего, жив. Цена — редкий немой ролик, если голос
 *   действительно исчез ровно во время сбоя; его видно по `voiceStatus`.
 * - Голос по умолчанию (`voiceId: null`) каталогом не проверяется: его
 *   задаёт стенд (`SONIOX_TTS_VOICE`).
 */
export async function sonioxVoiceProblem(
  tts: SonioxTtsLike,
  voiceId: string | null | undefined,
): Promise<GreetingErrorBody | null> {
  if (!tts.configured()) {
    return greetingError(
      GREETING_ERROR_CODES.GREETING_SONIOX_UNAVAILABLE,
      GREETING_SONIOX_UNAVAILABLE_MESSAGE,
    );
  }
  const id = voiceId?.trim() || null;
  if (!id) return null;
  const unknown = greetingError(
    GREETING_ERROR_CODES.GREETING_SONIOX_VOICE_UNKNOWN,
    GREETING_SONIOX_VOICE_UNKNOWN_MESSAGE,
  );
  if (!SONIOX_VOICE_ID_PATTERN.test(id)) return unknown;
  const catalog = await tts.voices().catch(() => null);
  if (!catalog || (catalog.error && !catalog.voices.length)) return null;
  return catalog.voices.some((v) => v.voiceId === id) ? null : unknown;
}
