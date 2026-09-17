/**
 * Локаль интерфейса → локаль `Intl` (этап 121).
 *
 * Жила копией внутри `PublishPanel`; с появлением второго и третьего
 * места, где показывается дата прогона, копий стало бы три — а
 * расхождение между ними человек увидел бы как разный формат даты на
 * соседних экранах.
 */
export const INTL_LOCALE: Record<string, string> = {
  ru: 'ru-RU',
  uk: 'uk-UA',
  en: 'en-US',
  de: 'de-DE',
  es: 'es-ES',
};

/** Короткая дата-время прогона: «03.09, 14:20». */
export function formatRunTime(iso: string, locale: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  return new Date(t).toLocaleString(INTL_LOCALE[locale] ?? 'ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}
