/**
 * Searchable country picker — spec §6.3: "с поиском/фильтром, не простой
 * <select> на 190+ пунктов". Filters the full list client-side (the
 * reference endpoint ships all 253 rows, ~15 KB) by Russian/English name or
 * ISO code; shows the currency that will be derived (§7.2) so the user
 * sees the consequence of the choice before saving.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Search } from 'lucide-react';
import { useI18n } from '../../lib/i18n-context';
import type { CountryOption } from '../../types/project';

const MAX_ROWS = 40;

export function CountryPicker({
  countries,
  value,
  onChange,
  disabled,
}: {
  countries: CountryOption[];
  value: string | null;
  onChange: (code: string) => void;
  disabled?: boolean;
}) {
  const { dict } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  const selected = useMemo(
    () => countries.find((c) => c.code === value) ?? null,
    [countries, value]
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return countries.slice(0, MAX_ROWS);
    return countries
      .filter(
        (c) =>
          c.nameRu.toLowerCase().includes(q) ||
          c.nameEn.toLowerCase().includes(q) ||
          c.code.toLowerCase() === q ||
          c.currency.toLowerCase() === q
      )
      .sort((a, b) => {
        // exact/prefix matches first
        const score = (c: CountryOption) =>
          c.code.toLowerCase() === q
            ? 0
            : c.nameRu.toLowerCase().startsWith(q) ||
                c.nameEn.toLowerCase().startsWith(q)
              ? 1
              : 2;
        return score(a) - score(b) || a.nameRu.localeCompare(b.nameRu, 'ru');
      })
      .slice(0, MAX_ROWS);
  }, [countries, query]);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const onDoc = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    // Этап 50 (В-5.19): список закрывается и клавиатурой — раньше только
    // кликом вне, и с клавиатуры из него было не выйти.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={boxRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={
          selected
            ? dict.countryPicker.ariaSelected.replace(
                '{{name}}',
                selected.nameRu
              )
            : dict.countryPicker.selectPlaceholder
        }
        className="input flex items-center justify-between gap-2 text-left"
      >
        {selected ? (
          <span className="flex min-w-0 items-center gap-2">
            <span className="tabular text-xs text-silver-400">
              {selected.code}
            </span>
            <span className="truncate">{selected.nameRu}</span>
            <span className="tabular text-xs text-accent">
              {selected.currency}
            </span>
          </span>
        ) : (
          <span className="text-silver-400">
            {dict.countryPicker.selectPlaceholder}
          </span>
        )}
        <ChevronDown size={14} className="shrink-0 text-silver-400" />
      </button>

      {open && (
        <div className="absolute z-20 mt-1 w-full overflow-hidden rounded-xl border border-silver-200/70 dark:border-silver-800 bg-white dark:bg-silver-900 shadow-card animate-fadeIn">
          <div className="relative border-b border-silver-200/60 dark:border-silver-800">
            <Search
              size={14}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-silver-400"
            />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={dict.countryPicker.searchPlaceholder}
              aria-label={dict.countryPicker.searchAriaLabel}
              className="w-full min-h-[44px] bg-transparent py-2 pl-8 pr-3 text-sm outline-none placeholder:text-silver-400"
            />
          </div>
          <ul className="max-h-64 overflow-y-auto py-1">
            {filtered.length === 0 && (
              <li className="px-3 py-3 text-center text-xs text-silver-400">
                {dict.countryPicker.noResults}
              </li>
            )}
            {filtered.map((c) => {
              const active = c.code === value;
              return (
                <li key={c.code}>
                  <button
                    type="button"
                    onClick={() => {
                      onChange(c.code);
                      setOpen(false);
                      setQuery('');
                    }}
                    className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-silver-100 dark:hover:bg-silver-800/60 ${
                      active ? 'text-accent' : ''
                    }`}
                  >
                    <span className="tabular w-7 shrink-0 text-xs text-silver-400">
                      {c.code}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{c.nameRu}</span>
                    <span className="tabular text-xs text-silver-400">
                      {c.currency}
                    </span>
                    {active && <Check size={14} className="shrink-0" />}
                  </button>
                </li>
              );
            })}
            {!query && countries.length > MAX_ROWS && (
              <li className="px-3 py-2 text-center text-[11px] text-silver-400">
                {dict.countryPicker.truncatedHint.replace(
                  '{{max}}',
                  String(MAX_ROWS)
                )}
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
