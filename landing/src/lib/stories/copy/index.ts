import type { Locale } from '../../i18n';
import { de } from './de';
import { en } from './en';
import { es } from './es';
import { ru } from './ru';
import type { StoriesCopy } from './types';
import { uk } from './uk';

export { BRAND, type StoriesCopy } from './types';

/**
 * Тексты Story‑Tales по локали. `Record<Locale, …>`: шестая локаль
 * лендинга не соберётся, пока у этой страницы нет её текстов, — пустых
 * языковых версий не бывает (ТЗ §7).
 */
export const STORIES_COPY: Readonly<Record<Locale, StoriesCopy>> = { ru, uk, en, de, es };

export function getStoriesCopy(locale: Locale): StoriesCopy {
  return STORIES_COPY[locale] ?? ru;
}
