/**
 * Можно ли переозвучить ролик — зеркало бэкендового правила
 * (backend/src/common/revoice-eligibility.ts), которым решают и список
 * «Постпрод» (`canRevoice`/`revoiceBlock`), и сам `reVoice()`.
 *
 * Зачем зеркало, а не только поле из списка: экран одного ролика
 * (`PostprodVideoScreen`) грузит сессию, а не строку списка, и должен
 * погасить кнопку ДО того, как человек выберет провайдера и голос —
 * иначе выбор упирается в 404 при сохранении в снимок бренда (П-8).
 * Сервер всё равно проверит то же самое и откажет словами.
 */
import { usesOwnVoice } from './voice-mode';
import type { VoiceMode } from '../types';

/** Те же значения, что у бэкенда — строка приходит в ответе списка. */
export type RevoiceBlock = 'veo-voice' | 'no-voice-settings';

export function revoiceBlock(facts: {
  voiceMode: VoiceMode | null | undefined;
  hasBrandSnapshot: boolean;
  /** Поздравление держит голос в снимке брифа, брендбука у него нет. */
  hasGreetingSnapshot: boolean;
}): RevoiceBlock | null {
  // Veo первым: снимок человеку не поможет, дорожки всё равно нет.
  if (!usesOwnVoice(facts.voiceMode ?? undefined)) return 'veo-voice';
  if (!facts.hasBrandSnapshot && !facts.hasGreetingSnapshot) {
    return 'no-voice-settings';
  }
  return null;
}
