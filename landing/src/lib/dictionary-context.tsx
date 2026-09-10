'use client';

import { createContext, useContext, type ReactNode } from 'react';
import type { Dictionary } from './get-dictionary';
import type { Locale } from './i18n';

/**
 * Словарь и текущая локаль прокидываются через контекст, а не пропсами
 * через каждый компонент — Header/Faq/LocaleSwitcher уже были клиентскими
 * компонентами до этой правки (`'use client'` для интерактивности меню и
 * аккордеона), так что читать их через `useDictionary()` дешевле и
 * устойчивее к рефакторингу, чем протаскивать `dict`/`locale` вручную.
 * Серверные компоненты (page.tsx, layout.tsx) читают словарь напрямую
 * через `getDictionary(locale)` — контекст им не нужен.
 */
const DictionaryContext = createContext<{ dict: Dictionary; locale: Locale } | null>(null);

export function DictionaryProvider({
  dict,
  locale,
  children,
}: {
  dict: Dictionary;
  locale: Locale;
  children: ReactNode;
}) {
  return (
    <DictionaryContext.Provider value={{ dict, locale }}>{children}</DictionaryContext.Provider>
  );
}

export function useDictionary(): { dict: Dictionary; locale: Locale } {
  const ctx = useContext(DictionaryContext);
  if (!ctx) {
    // Громкая ошибка вместо тихого рендера с пустым текстом — тот же
    // принцип, что и в остальном проекте (см. rate-limit.ts,
    // http-exception.filter.ts): пропущенный провайдер должен падать
    // явно на разработке, а не показывать пользователю пустые блоки.
    throw new Error('useDictionary() вызван вне <DictionaryProvider> — оберните дерево в app/[locale]/layout.tsx');
  }
  return ctx;
}
