'use client';
import { LOCALE_COOKIE, LOCALE_LABELS, locales, type Locale } from '../../../../lib/i18n';

/** Native dropdown preserves the current section and campaign parameters. */
export function StoriesLocaleMenu({ current, label }: { current: Locale; label: string }) {
  return <div className="st-lang"><label><span className="sr-only">{label}</span>
    <select aria-label={label} value={current} onChange={(event) => {
      const next = event.target.value as Locale;
      if (!locales.includes(next) || next === current) return;
      const url = new URL(window.location.href);
      url.pathname = url.pathname.replace(new RegExp(`^/${current}(?=/|$)`), `/${next}`);
      document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=${60 * 60 * 24 * 365}; SameSite=Lax`;
      window.location.assign(url.href);
    }}>{locales.map(l => <option key={l} value={l} lang={l}>{LOCALE_LABELS[l]}</option>)}</select>
  </label><noscript><ul>{locales.map(l => <li key={l}><a href={`/${l}`} hrefLang={l} lang={l}>{LOCALE_LABELS[l]}</a></li>)}</ul></noscript></div>;
}
