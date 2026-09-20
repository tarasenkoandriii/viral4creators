'use client';

import { createContext, useContext, type ReactNode } from 'react';
import type { Dictionary } from './get-dictionary';
import type { Locale } from './i18n';

/**
 * Словарь и текущая локаль прокидываются через контекст — тот же приём,
 * что в landing/src/lib/dictionary-context.tsx. Большинство экранов
 * маркетплейса и так клиентские (формы брифа, квиза, брендбука), так что
 * читать через useDictionary() дешевле, чем протаскивать dict/locale
 * пропсами через каждый уровень. Серверные компоненты (page.tsx под
 * [locale]) читают словарь напрямую через getDictionary(locale).
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
  return <DictionaryContext.Provider value={{ dict, locale }}>{children}</DictionaryContext.Provider>;
}

export function useDictionary(): { dict: Dictionary; locale: Locale } {
  const ctx = useContext(DictionaryContext);
  if (!ctx) {
    throw new Error('useDictionary() вызван вне <DictionaryProvider> — оберните дерево в app/[locale]/layout.tsx');
  }
  return ctx;
}
