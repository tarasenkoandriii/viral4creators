import type { Locale } from '../kit';
import { appEn } from './en';
import { appRu, type AppDictionary } from './ru';
import { appUk } from './uk';

const APP: Record<Locale, AppDictionary> = { uk: appUk, ru: appRu, en: appEn };

export function getAppDictionary(locale: Locale): AppDictionary {
  return APP[locale];
}

export type { AppDictionary };
