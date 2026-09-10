'use client';

import { usePathname, useRouter } from 'next/navigation';
import { locales, LOCALE_LABELS, LOCALE_COOKIE, type Locale } from '../lib/i18n';
import { useDictionary } from '../lib/dictionary-context';

/**
 * Переключатель языка (этап 55). Пишет cookie NEXT_LOCALE — единственный
 * сигнал, который middleware.ts считает явным выбором человека (см.
 * комментарий там) — и переходит на тот же путь под новым префиксом, а
 * не на главную: смена языка не должна сбрасывать, где человек находился
 * на странице (якоря #faq, #plans и т.д. сохраняются автоматически, они
 * не часть pathname).
 */
export function LocaleSwitcher() {
  const { locale: current, dict } = useDictionary();
  const pathname = usePathname();
  const router = useRouter();

  function switchTo(next: Locale) {
    if (next === current) return;
    // cookie на год — тот же порядок величины, что и у большинства
    // выбранных вручную предпочтений (нет смысла спрашивать чаще).
    document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=${60 * 60 * 24 * 365}; SameSite=Lax`;
    const rest = pathname?.replace(new RegExp(`^/${current}(?=/|$)`), '') ?? '';
    router.push(`/${next}${rest}`);
  }

  return (
    <label className="locale-switcher">
      <span className="sr-only">{dict.localeSwitcher.label}</span>
      <select
        value={current}
        onChange={(e) => switchTo(e.target.value as Locale)}
        aria-label={dict.localeSwitcher.label}
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
