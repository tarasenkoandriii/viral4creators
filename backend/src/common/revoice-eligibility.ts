/**
 * Можно ли переозвучить готовый ролик — ОДНО правило на два места:
 * список «Постпрод» (`PostprodVideosService`, признак `canRevoice` у
 * каждой строки) и сама переозвучка (`PostProductionService.reVoice`).
 *
 * Почему одна функция (П-8, TZ-Enterprise-Tutorial-Landing): раньше
 * список решал по одному `voiceMode`, а сессия без снимка бренда
 * получала кнопку, после выбора провайдера и голоса упиралась в 404 на
 * `PATCH /sessions/:id/brand-manifest` — человек тратил время на выбор,
 * который некуда сохранить. Два независимых условия в двух местах уже
 * однажды разошлись; общий вход не даёт им разойтись снова.
 *
 * Входы у мест разные по происхождению (список — сохранённый
 * `generatedVideo.voiceMode` из SQL-проекции, переозвучка — режим,
 * пересчитанный `planWork()` по живой сессии; см. «Д-новое» в
 * TZ-Enterprise-Tutorial-Landing) — это известное и принятое
 * расхождение источника, но не правила.
 *
 * Зеркало на фронтенде — `frontend/src/lib/revoice-eligibility.ts`:
 * экран ролика гасит кнопку тем же правилом, до запроса.
 */
import { isVoiceMode, usesOwnVoice } from './voice-mode';

/**
 * Почему переозвучка невозможна:
 * - `veo-voice` — голос вшит в рендер самой моделью, своей дорожки нет,
 *   накладывать новую не на что;
 * - `no-voice-settings` — у сессии нет ни снимка брендбука, ни снимка
 *   брифа поздравления: голос для синтеза негде взять и некуда
 *   сохранить выбор (правка голоса идёт в снимок бренда).
 */
export type RevoiceBlock = 'veo-voice' | 'no-voice-settings';

export interface RevoiceFacts {
  /** Режим озвучки; неизвестное/пустое значение читается как «нельзя». */
  voiceMode: unknown;
  hasBrandSnapshot: boolean;
  /** Поздравление держит голос в своём снимке брифа (`senderVoice` и
   * соседи), брендбука у него нет по замыслу — его переозвучка законна. */
  hasGreetingSnapshot: boolean;
}

export function revoiceBlock(facts: RevoiceFacts): RevoiceBlock | null {
  // Сначала Veo: если дорожки нет, про снимок человеку говорить незачем —
  // это не та причина, которую он может исправить.
  if (!isVoiceMode(facts.voiceMode) || !usesOwnVoice(facts.voiceMode)) {
    return 'veo-voice';
  }
  if (!facts.hasBrandSnapshot && !facts.hasGreetingSnapshot) {
    return 'no-voice-settings';
  }
  return null;
}

/** Текст отказа для `reVoice()` — человеческими словами, он доходит до кнопки. */
export const REVOICE_BLOCK_MESSAGE: Record<RevoiceBlock, string> = {
  'veo-voice':
    'переозвучка недоступна — в этом ролике голос ведёт сама Veo, отдельной звуковой дорожки нет',
  'no-voice-settings':
    'переозвучка недоступна — у этого ролика нет снимка брендбука, голос для новой дорожки негде взять и некуда сохранить',
};
