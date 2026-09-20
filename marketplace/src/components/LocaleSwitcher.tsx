'use client';

import { usePathname, useRouter } from 'next/navigation';
import { locales, LOCALE_LABELS, LOCALE_COOKIE, type Locale } from '../lib/i18n';
import { useDictionary } from '../lib/dictionary-context';

/**
 * Переключатель языка — тот же приём, что landing/src/components/
 * LocaleSwitcher.tsx: cookie NEXT_LOCALE как единственный сигнал явного
 * выбора человека для middleware.ts, переход на тот же путь под новым
 * префиксом (не на главную), чтобы не сбрасывать, где человек находился.
 */
export function LocaleSwitcher() {
  const { locale: current, dict } = useDictionary();
  const pathname = usePathname();
  const router = useRouter();

  function switchTo(next: Locale) {
    if (next === current) return;
    document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=${60 * 60 * 24 * 365}; SameSite=Lax`;
    const rest = pathname?.replace(new RegExp(`^/${current}(?=/|$)`), '') ?? '';
    router.push(`/${next}${rest}`);
  }

  return (
    <label style={{ display: 'inline-flex', alignItems: 'center' }}>
      <span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>
        {dict.localeSwitcher.label}
      </span>
      <select
        className="mp-filter-input"
        value={current}
        onChange={(e) => switchTo(e.target.value as Locale)}
        aria-label={dict.localeSwitcher.label}
        style={{ padding: '6px 8px' }}
      >
        {locales.map((l) => (
          <option key={l} value={l}>
            {LOCALE_LABELS[l]}
          </option>
        ))}
      </select>
    </label>
  );
}
