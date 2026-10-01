/* СГЕНЕРИРОВАНО scripts/sync-site-tma-kit.mjs — не править. Источник: site-tma-kit/src/kit-context.ts */
/**
 * Контекст кабинета: словарь, API, кабинет. Файл `.ts` без JSX (как
 * `frontend/src/lib/i18n-context.ts`): Provider подставляет приложение,
 * а правило react-refresh не спорит с экспортом хуков.
 */

import { createContext, useContext } from 'react';
import type { TelegramAppId } from './brand';
import type { Dictionary } from './dictionaries/ru';
import type { Locale } from './i18n';
import type { SitesApi } from './sites-api';
import type { AuthMode } from './telegram';
import type { AccountInfo } from './types';

export interface KitValue {
  app: TelegramAppId;
  locale: Locale;
  dict: Dictionary;
  setLocale: (l: Locale) => void;
  api: SitesApi;
  account: AccountInfo;
  /** TMA (initData) / дев-стенд / веб-кабинет (cookie-сессия). */
  mode: AuthMode;
  /** Для ссылок-приглашений: бот (`t.me/<бот>?startapp=`) и адрес веба. */
  links: { botUsername: string | null; webUrl: string };
  /** Перечитать кабинет (после приглашения, смены кабинета). */
  reloadAccount: () => void;
}

export const KitContext = createContext<KitValue | null>(null);

export function useKit(): KitValue {
  const v = useContext(KitContext);
  if (!v) {
    // Пропущенный провайдер — ошибка разработки, пусть будет громкой.
    throw new Error('useKit() вызван вне <KitContext.Provider>');
  }
  return v;
}
