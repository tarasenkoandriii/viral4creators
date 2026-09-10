/**
 * YoutubeSearch — the "поиск YouTube" tab of the reference-video step
 * (spec §6.4 / §9, Stage 12). A tracing of the same tab in Devil's
 * Advocate (`apps/admin/src/app/sandbox/page.tsx`, «Шаг 1 — поиск
 * YouTube»): one input + «Искать» button (Enter submits), an explicit
 * search — never on keystroke, every call is 100 quota units — then a
 * plain line with the count / timing / quota accounting and a table
 * whose last column is the action. What this app adds on top of DA is
 * exactly what its spec asks for: the extra columns (превью, просмотры,
 * лайки) and client-side sorting by clicking a column header (§9.3: the
 * whole set of 50 arrives at once, so sorting needs no server).
 *
 * Search needs an identity (the per-user daily cap + a Google quota that
 * is shared by the whole deployment); the anonymous quick path is told
 * so and pointed at the two other tabs (§9.2).
 */

import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ExternalLink,
  Search,
} from 'lucide-react';
import { Alert, Button, Input } from './ui';
import {
  errorMessage,
  isUnauthorized,
  searchYoutube,
} from '../services/projects-api';
import type { YoutubeSearchResponse, YoutubeSearchResultView } from '../types';
import {
  formatCount,
  NUMERIC_SORT_KEYS,
  sortResults,
  type SortDir,
  type SortKey,
} from '../lib/youtube-search';
import { useI18n } from '../lib/i18n-context';

export interface YoutubeSearchDefaults {
  /** Pre-filled query — ProductItem title/category (§9.1), editable. */
  query?: string | null;
  regionCode?: string | null;
  language?: string | null;
}

export function YoutubeSearch({
  defaults,
  onSelect,
  disabled,
}: {
  defaults?: YoutubeSearchDefaults;
  /** Hands the pick to the existing registerYoutubeVideo flow. */
  onSelect: (url: string) => void;
  disabled?: boolean;
}) {
  const { dict, locale } = useI18n();
  const [query, setQuery] = useState(defaults?.query ?? '');
  const [searching, setSearching] = useState(false);
  const [search, setSearch] = useState<
    (YoutubeSearchResponse & { tookMs: number }) | null
  >(null);
  const [error, setError] = useState<unknown>(null);
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir } | null>(null);
  const [picked, setPicked] = useState<string | null>(null);

  const handleSearch = async (e?: FormEvent) => {
    e?.preventDefault();
    const q = query.trim();
    if (!q || searching) return;
    setSearching(true);
    setError(null);
    const started = performance.now();
    try {
      const res = await searchYoutube(q, {
        regionCode: defaults?.regionCode,
        language: defaults?.language,
      });
      setSearch({ ...res, tookMs: Math.round(performance.now() - started) });
      setSort(null);
    } catch (err) {
      setSearch(null);
      setError(err);
    } finally {
      setSearching(false);
    }
  };

  const toggleSort = (key: SortKey) =>
    setSort((cur) => {
      if (cur?.key === key)
        return { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' };
      // Numbers start "biggest first", text — alphabetical.
      return { key, dir: NUMERIC_SORT_KEYS.has(key) ? 'desc' : 'asc' };
    });

  const rows = useMemo(
    () => (search ? sortResults(search.results, sort, locale) : []),
    [search, sort, locale]
  );

  const pick = (r: YoutubeSearchResultView) => {
    setPicked(r.videoId);
    onSelect(r.url);
  };

  return (
    <div className="space-y-3">
      <form onSubmit={handleSearch} className="flex gap-2">
        <div className="relative flex-1">
          <Search
            size={14}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-silver-400"
          />
          <Input
            id="youtube-search-q"
            value={query}
            placeholder={dict.youtubeSearch.searchPlaceholder}
            onChange={(e) => setQuery(e.target.value)}
            disabled={disabled || searching}
            maxLength={200}
            className="pl-8"
          />
        </div>
        <Button
          type="submit"
          disabled={disabled || searching || !query.trim()}
          loading={searching}
        >
          {searching ? dict.youtubeSearch.searching : dict.youtubeSearch.search}
        </Button>
      </form>

      {defaults?.query && !search && !error && (
        <p className="text-xs text-silver-400">
          {dict.youtubeSearch.prefillHint}
        </p>
      )}

      {error !== null &&
        (isUnauthorized(error) ? (
          <Alert tone="info">{dict.youtubeSearch.authRequired}</Alert>
        ) : (
          <Alert tone="error">{errorMessage(error)}</Alert>
        ))}

      {search && (
        <>
          <p className="text-xs text-silver-400">
            {dict.youtubeSearch.resultsSummary
              .replace('{{count}}', String(search.results.length))
              .replace('{{ms}}', String(search.tookMs))
              .replace('{{used}}', String(search.usage.used))
              .replace('{{limit}}', String(search.usage.limit))}
          </p>

          {search.results.length === 0 ? (
            <p className="py-6 text-center text-sm text-silver-400">
              {dict.youtubeSearch.noResults}
            </p>
          ) : (
            <div className="-mx-1 overflow-x-auto">
              <table className="w-full min-w-[520px] text-left text-xs">
                <thead className="text-[11px] uppercase tracking-wider text-silver-400">
                  <tr className="border-b border-silver-200/60 dark:border-silver-800">
                    <Th
                      label={dict.youtubeSearch.colVideo}
                      active={sort?.key === 'title' ? sort.dir : null}
                      onClick={() => toggleSort('title')}
                      className="pl-1"
                    />
                    <Th
                      label={dict.youtubeSearch.colChannel}
                      active={sort?.key === 'channelTitle' ? sort.dir : null}
                      onClick={() => toggleSort('channelTitle')}
                    />
                    <Th
                      label={dict.youtubeSearch.colDuration}
                      active={sort?.key === 'durationSeconds' ? sort.dir : null}
                      onClick={() => toggleSort('durationSeconds')}
                      align="right"
                    />
                    <Th
                      label={dict.youtubeSearch.colViews}
                      active={sort?.key === 'viewCount' ? sort.dir : null}
                      onClick={() => toggleSort('viewCount')}
                      align="right"
                    />
                    <Th
                      label={dict.youtubeSearch.colLikes}
                      active={sort?.key === 'likeCount' ? sort.dir : null}
                      onClick={() => toggleSort('likeCount')}
                      align="right"
                    />
                    <th className="py-2 pr-1" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr
                      key={r.videoId}
                      // Spec §9: клик по строке — выбор. The button at the end
                      // is the explicit affordance (and the only thing a
                      // screen reader announces as actionable).
                      onClick={() => !disabled && pick(r)}
                      className={`cursor-pointer border-b border-silver-200/40 dark:border-silver-800/60 align-top transition-colors hover:bg-accent/5 ${
                        picked === r.videoId ? 'bg-accent/10' : ''
                      }`}
                    >
                      <td className="py-2 pl-1 pr-2">
                        <div className="flex items-start gap-2">
                          <div className="h-10 w-[72px] shrink-0 overflow-hidden rounded-md bg-silver-200/60 dark:bg-silver-800/60">
                            {r.thumbnailUrl && (
                              <img
                                src={r.thumbnailUrl}
                                alt=""
                                loading="lazy"
                                className="h-full w-full object-cover"
                              />
                            )}
                          </div>
                          <div className="min-w-0">
                            <a
                              href={r.url}
                              target="_blank"
                              rel="noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              className="line-clamp-2 font-medium text-silver-800 hover:text-accent dark:text-silver-100"
                              title={r.title}
                            >
                              {r.title}
                            </a>
                            <span className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-silver-400">
                              <ExternalLink size={9} /> YouTube
                            </span>
                          </div>
                        </div>
                      </td>
                      <td className="max-w-[140px] truncate py-2 pr-2 text-silver-500">
                        {r.channelTitle}
                      </td>
                      <td className="whitespace-nowrap py-2 pr-2 text-right tabular">
                        {r.durationLabel ?? '—'}
                      </td>
                      <td className="whitespace-nowrap py-2 pr-2 text-right tabular">
                        {formatCount(r.viewCount, locale)}
                      </td>
                      <td className="whitespace-nowrap py-2 pr-2 text-right tabular">
                        {formatCount(r.likeCount, locale)}
                      </td>
                      <td className="py-2 pr-1 text-right">
                        <Button
                          size="sm"
                          variant={picked === r.videoId ? 'solid' : 'outline'}
                          onClick={(e) => {
                            e.stopPropagation();
                            pick(r);
                          }}
                          disabled={disabled}
                          loading={disabled && picked === r.videoId}
                        >
                          {dict.youtubeSearch.select}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Th({
  label,
  active,
  onClick,
  align = 'left',
  className = '',
}: {
  label: ReactNode;
  active: SortDir | null;
  onClick: () => void;
  align?: 'left' | 'right';
  className?: string;
}) {
  const Icon =
    active === 'asc' ? ArrowUp : active === 'desc' ? ArrowDown : ArrowUpDown;
  return (
    <th
      aria-sort={
        active === 'asc'
          ? 'ascending'
          : active === 'desc'
            ? 'descending'
            : 'none'
      }
      className={`py-2 pr-2 font-medium ${align === 'right' ? 'text-right' : ''} ${className}`}
    >
      <button
        type="button"
        onClick={onClick}
        className={`inline-flex items-center gap-1 whitespace-nowrap uppercase tracking-wider hover:text-accent ${
          active ? 'text-accent' : ''
        }`}
      >
        {label}
        <Icon size={10} className={active ? '' : 'opacity-50'} />
      </button>
    </th>
  );
}
