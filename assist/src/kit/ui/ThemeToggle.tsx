/* СГЕНЕРИРОВАНО scripts/sync-site-tma-kit.mjs — не править. Источник: site-tma-kit/src/ui/ThemeToggle.tsx */
import { Moon, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';
import { setTheme } from '../telegram';
import type { Locale } from '../i18n';

const labels = {
  ru: ['Включить тёмную тему', 'Включить светлую тему'],
  uk: ['Увімкнути темну тему', 'Увімкнути світлу тему'],
  en: ['Use dark theme', 'Use light theme'],
};
export function ThemeToggle({ locale }: { locale: Locale }) {
  const [dark, setDark] = useState(() =>
    document.documentElement.classList.contains('dark')
  );
  useEffect(() => {
    const update = () =>
      setDark(document.documentElement.classList.contains('dark'));
    window.addEventListener('v4c-theme-changed', update);
    return () => window.removeEventListener('v4c-theme-changed', update);
  }, []);
  const label = labels[locale][dark ? 1 : 0];
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={() => setTheme(dark ? 'light' : 'dark')}
      className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full bg-silver-200/60 text-silver-600 dark:bg-silver-800/60 dark:text-silver-300 focus:outline-none focus:ring-2 focus:ring-accent"
    >
      {dark ? (
        <Moon size={17} aria-hidden="true" />
      ) : (
        <Sun size={17} aria-hidden="true" />
      )}
    </button>
  );
}
