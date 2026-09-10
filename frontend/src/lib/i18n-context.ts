/**
 * Контекст локали (этап 55) — по тому же образцу, что и plan-context.ts:
 * файл намеренно `.ts`, без JSX, `I18nContext.Provider` подставляется в
 * main.tsx напрямую. Так рядом с хуками не оказывается компонента, и
 * правило `react-refresh/only-export-components` не спорит с экспортом
 * хуков из одного модуля.
 */

import { createContext, useContext, useMemo, useState } from 'react';
import { getDictionary, type Dictionary } from './get-dictionary';
import { getTelegramWebApp } from './telegram';
import { initialLocale, storeLocale, type Locale } from './i18n';

export interface I18nValue {
  locale: Locale;
  dict: Dictionary;
  setLocale: (locale: Locale) => void;
}

export const I18nContext = createContext<I18nValue | null>(null);

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    // Та же логика, что и в http-exception.filter/rate-limit: пропущенный
    // провайдер — ошибка разработки, и она должна быть громкой, а не
    // тихим рендером без текста.
    throw new Error(
      'useI18n() вызван вне <I18nProvider> — оберните дерево в main.tsx'
    );
  }
  return ctx;
}

/** Собирает значение для `<I18nContext.Provider>` — вызывается один раз
 * в корневом компоненте (main.tsx). */
export function useI18nValue(): I18nValue {
  const [locale, setLocaleState] = useState<Locale>(() =>
    initialLocale(getTelegramWebApp()?.initDataUnsafe?.user?.language_code)
  );

  const setLocale = (next: Locale) => {
    setLocaleState(next);
    storeLocale(next);
  };

  return useMemo<I18nValue>(
    () => ({ locale, dict: getDictionary(locale), setLocale }),
    [locale]
  );
}
