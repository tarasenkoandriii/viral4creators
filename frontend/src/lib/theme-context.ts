/**
 * Контекст темы (этап 81) — по тому же образцу, что и i18n-context.ts:
 * файл намеренно `.ts`, без JSX (react-refresh/only-export-components,
 * тот же приём). Провайдер — в AppRoot.tsx, как и I18nContext.
 */

import { createContext, useContext, useEffect, useState } from 'react';
import { applyTheme, getTelegramWebApp } from './telegram';
import {
  readStoredThemePreference,
  storeThemePreference,
  type ThemePreference,
} from './theme';

export interface ThemeValue {
  theme: ThemePreference;
  setTheme: (theme: ThemePreference) => void;
}

export const ThemeContext = createContext<ThemeValue | null>(null);

export function useTheme(): ThemeValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error(
      'useTheme() вызван вне <ThemeContext.Provider> — оберните дерево в main.tsx'
    );
  }
  return ctx;
}

/** <html> уже несёт верный класс к моменту первого рендера — его
 * выставляет applyTheme() внутри initTelegramWebApp() (main.tsx), ДО
 * ReactDOM.createRoot(...).render(...). Читаем его же, а не пересчитываем
 * условия заново, чтобы не разойтись с тем, что реально видит человек. */
function currentEffectiveTheme(): ThemePreference {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

/** Собирает значение для `<ThemeContext.Provider>` — вызывается один раз
 * в корневом компоненте (AppRoot.tsx). */
export function useThemeValue(): ThemeValue {
  const [theme, setThemeState] = useState<ThemePreference>(
    currentEffectiveTheme
  );

  // Живая смена темы САМОГО Telegram или системной настройки — только
  // пока человек ни разу не переключал тему явно в этом приложении
  // (иначе явный выбор должен оставаться в силе, applyTheme() это уже
  // обеспечивает; здесь — только чтобы иконка ThemeToggle не отставала
  // от факта, если человек ещё не переключал вручную).
  useEffect(() => {
    if (readStoredThemePreference()) return;
    const sync = () => setThemeState(currentEffectiveTheme());
    const mq =
      typeof window !== 'undefined' && window.matchMedia
        ? window.matchMedia('(prefers-color-scheme: dark)')
        : null;
    mq?.addEventListener?.('change', sync);
    const webApp = getTelegramWebApp();
    webApp?.onEvent?.('themeChanged', sync);
    return () => mq?.removeEventListener?.('change', sync);
  }, []);

  const setTheme = (next: ThemePreference) => {
    storeThemePreference(next);
    applyTheme();
    setThemeState(next);
    // Системная шапка Telegram — тот же приём, что и при живой смене
    // темы Telegram (initTelegramWebApp() в lib/telegram.ts).
    const webApp = getTelegramWebApp();
    if (webApp) {
      const chrome = next === 'light' ? '#f7f8fa' : '#0e1621';
      webApp.setBackgroundColor(chrome);
      webApp.setHeaderColor(chrome);
    }
  };

  return { theme, setTheme };
}
