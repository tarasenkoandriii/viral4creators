/**
 * Локали кабинета: uk, ru, en (ТЗ помощника §3.0).
 *
 * Начальный язык — язык Telegram-клиента (`language_code` — явная
 * настройка человека в Telegram, не угадывание). Явный выбор в
 * переключателе важнее и запоминается. Если язык Telegram не из трёх —
 * английский (польскому или немецкому пользователю английский понятнее
 * русского); если Telegram язык не сообщил вовсе (браузер, дев-стенд) —
 * украинский: первые заказчики — в Украине.
 */

import { STORAGE_PREFIX } from './brand';
import { en } from './dictionaries/en';
import { ru, type Dictionary } from './dictionaries/ru';
import { uk } from './dictionaries/uk';

export const LOCALES = ['uk', 'ru', 'en'] as const;
export type Locale = (typeof LOCALES)[number];

export const LOCALE_LABELS: Record<Locale, string> = {
  uk: 'Українська',
  ru: 'Русский',
  en: 'English',
};

const DICTS: Record<Locale, Dictionary> = { uk, ru, en };

export function getDictionary(locale: Locale): Dictionary {
  return DICTS[locale];
}

export function isLocale(v: unknown): v is Locale {
  return typeof v === 'string' && (LOCALES as readonly string[]).includes(v);
}

export function localeFromTelegram(code: string | undefined): Locale | null {
  if (!code) return null;
  const short = code.slice(0, 2).toLowerCase();
  return isLocale(short) ? short : 'en';
}

export function resolveLocale(
  stored: string | null,
  telegramCode: string | undefined
): Locale {
  if (isLocale(stored)) return stored;
  return localeFromTelegram(telegramCode) ?? 'uk';
}

const KEY = `${STORAGE_PREFIX}locale`;

export function readStoredLocale(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null; // приватный режим — не повод падать
  }
}

export function storeLocale(locale: Locale): void {
  try {
    localStorage.setItem(KEY, locale);
  } catch {
    /* см. readStoredLocale */
  }
}

/** `fmt('Добавьте {n} записей', { n: 3 })`. Неизвестный ключ остаётся как есть. */
export function fmt(
  template: string,
  vars: Record<string, string | number>
): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) =>
    k in vars ? String(vars[k]) : m
  );
}
