/**
 * Жёстко вшитые субтитры (TODO §Уровень 2.7, этап 67) человеческими
 * словами.
 *
 * Тот же приём, что у `camera-move.ts`: тексты живут в словаре
 * (dict.subtitlesMode / dict.subtitleTheme), здесь — только стабильный
 * порядок вариантов и подстановка перевода по значению, чтобы состав
 * списка не зависел от языка интерфейса. Копия отдельно от экранов по
 * той же причине — выбор делается в двух местах (манифест бренда и
 * снимок для конкретного ролика), и два разных объяснения одной
 * настройки читались бы как две разные настройки.
 */
import type { SubtitlesMode, SubtitleTheme } from '../types';

const SUBTITLES_MODE_VALUES: SubtitlesMode[] = ['off', 'on'];
const SUBTITLE_THEME_VALUES: SubtitleTheme[] = ['classic', 'bold', 'minimal'];

export function subtitlesModeOptions(
  t: Record<SubtitlesMode, string>
): { value: SubtitlesMode; label: string }[] {
  return SUBTITLES_MODE_VALUES.map((value) => ({ value, label: t[value] }));
}

export function subtitleThemeOptions(
  t: Record<SubtitleTheme, string>
): { value: SubtitleTheme; label: string }[] {
  return SUBTITLE_THEME_VALUES.map((value) => ({ value, label: t[value] }));
}

/** Подсказка под текущим значением темы. */
export function subtitleThemeHint(
  theme: SubtitleTheme,
  t: Record<SubtitleTheme, string>
): string {
  return t[theme];
}
