import type { Locale } from './i18n';

const TAGS: Record<Locale, string> = { uk: 'uk-UA', ru: 'ru-RU', en: 'en-GB' };

/** «30.12.2026» в языке интерфейса; битая дата — пустая строка, не «Invalid Date». */
export function formatDate(iso: string | null, locale: Locale): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  return new Intl.DateTimeFormat(TAGS[locale], {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(new Date(t));
}
