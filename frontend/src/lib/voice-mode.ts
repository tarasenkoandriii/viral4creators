/**
 * Режимы озвучки (§15.1) человеческими словами — общие для манифеста и
 * копии манифеста в сессии. Отдельный файл без компонентов: Fast Refresh
 * требует, чтобы файл с компонентом не экспортировал констант.
 *
 * Этап 56: сам текст подсказки переехал в словарь (dict.voiceMode.hints) —
 * эта функция только индексирует по режиму.
 */
import type { VoiceMode } from '../types';

export function voiceModeHint(
  mode: VoiceMode,
  t: Record<VoiceMode, string>
): string {
  return t[mode];
}

/**
 * Есть ли у ролика ОТДЕЛЬНАЯ звуковая дорожка, наложенная постобработкой
 * (§15.1) — в отличие от `'veo'`, где голос ведёт сама модель прямо в
 * кадре. Тот же смысл, что у бэкендового `usesOwnVoice`
 * (common/voice-mode.ts) — используется, чтобы решить, есть ли вообще
 * что переозвучить без повторного рендера (доп. запрос владельца
 * продукта, этап 87, `RevoicePanel`).
 */
export function usesOwnVoice(mode: VoiceMode | undefined): boolean {
  return mode === 'voiceover' || mode === 'dub';
}
