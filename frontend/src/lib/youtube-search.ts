/**
 * Client-side helpers of the YouTube search table (spec §6.4 / §9.3: the
 * whole result set — one page of 50 — is sorted here, not on the server).
 * Kept apart from the component so they unit-test without React.
 */

import type { YoutubeSearchResultView } from '../types';
import type { Locale } from './i18n';

export type SortKey =
  | 'title'
  | 'channelTitle'
  | 'durationSeconds'
  | 'viewCount'
  | 'likeCount';
export type SortDir = 'asc' | 'desc';

export const NUMERIC_SORT_KEYS: ReadonlySet<SortKey> = new Set([
  'durationSeconds',
  'viewCount',
  'likeCount',
]);

/**
 * Stable sort; `null` numbers always sink to the bottom whatever the
 * direction. `locale` (этап 56) — сравнение строк по алфавиту зависит от
 * языка (например, порядок букв с диакритикой в de/es), а раньше было
 * жёстко зашито `'ru'` независимо от выбранного интерфейса.
 */
export function sortResults(
  rows: YoutubeSearchResultView[],
  sort: { key: SortKey; dir: SortDir } | null,
  locale: Locale = 'ru'
): YoutubeSearchResultView[] {
  if (!sort) return rows;
  const sign = sort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = a[sort.key];
    const bv = b[sort.key];
    if (NUMERIC_SORT_KEYS.has(sort.key)) {
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      return ((av as number) - (bv as number)) * sign;
    }
    return (
      String(av).localeCompare(String(bv), locale, { sensitivity: 'base' }) *
      sign
    );
  });
}

/**
 * 12345 → "12,3 тыс." (ru), "12.3K" (en), "1,2 Mio." (de, млн+) — этап 56:
 * раньше суффиксы (тыс./млн/млрд) были зашиты по-русски независимо от
 * локали интерфейса. `Intl.NumberFormat` с `notation: 'compact'` даёт то
 * же самое число для ru (проверено — не меняет существующий вывод) и
 * настоящее локальное сокращение для остальных четырёх языков, вместо
 * ручного подбора суффиксов на каждый.
 */
export function formatCount(n: number | null, locale: Locale = 'ru'): string {
  if (n === null) return '—';
  return new Intl.NumberFormat(locale, {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(n);
}
