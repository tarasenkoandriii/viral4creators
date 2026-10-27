'use client';
import { LOCALE_LABELS, LOCALE_SWITCH_PARAM, type Locale } from '../lib/i18n';

export function LocaleSelect({ locale, path, available, label }: {
  locale: Locale; path: string; available: readonly Locale[]; label: string;
}) {
  return <div className="locale-switcher"><label><span className="sr-only">{label}</span>
    <select aria-label={label} value={locale} onChange={(event) => {
      const next = event.target.value as Locale;
      if (next === locale || !available.includes(next)) return;
      const url = new URL(window.location.href);
      url.pathname = `/${next}${path}`;
      url.searchParams.set(LOCALE_SWITCH_PARAM, next);
      window.location.assign(url.href);
    }}>{available.map(l => <option key={l} value={l} lang={l}>{LOCALE_LABELS[l]}</option>)}</select>
  </label><noscript><ul>{available.map(l => <li key={l}><a href={`/${l}${path}?${LOCALE_SWITCH_PARAM}=${l}`} hrefLang={l} lang={l}>{LOCALE_LABELS[l]}</a></li>)}</ul></noscript></div>;
}
