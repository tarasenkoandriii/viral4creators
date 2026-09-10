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
