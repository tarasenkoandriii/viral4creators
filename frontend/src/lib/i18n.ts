/**
 * Мультиязычность TMA/браузерного фронта (этап 55) — пять языков:
 * ru/uk/en/de/es. Инфраструктура и первый слой экранов (шапка, футер,
 * граница ошибок, «страница не найдена») переведены в этом этапе;
 * остальные экраны (features/*, components/*) переводятся этапом 56 —
 * список см. в doc/PRODUCT-PROJECT-SPEC.md §35.
 *
 * defaultLocale = 'ru' — как и у лендинга (lib/i18n.ts там же): весь
 * существующий интерфейс написан по-русски, и без явного выбора
 * поведение для всех текущих пользователей не должно измениться ни на
 * бит.
 *
 * Хранение выбора — localStorage (не cookie, как у Next.js-лендинга):
 * это Vite SPA без сервера, который мог бы прочитать cookie до первого
 * рендера, поэтому localStorage — тот же уровень постоянства, что
 * cookie у лендинга, но без лишнего HTTP-заголовка на каждый запрос.
 */

export const locales = ['ru', 'uk', 'en', 'de', 'es'] as const;
export type Locale = (typeof locales)[number];

export const defaultLocale: Locale = 'ru';

export const LOCALE_LABELS: Record<Locale, string> = {
  ru: 'Русский',
  uk: 'Українська',
  en: 'English',
  de: 'Deutsch',
  es: 'Español',
};

export function isLocale(value: string | null | undefined): value is Locale {
  return !!value && (locales as readonly string[]).includes(value);
}

const STORAGE_KEY = 'v4c_locale';

/** Явный выбор человека, если он уже переключал язык в этом браузере. */
export function readStoredLocale(): Locale | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return isLocale(raw) ? raw : null;
  } catch {
    return null; // приватный режим/запрещённое хранилище — не блокирующая ошибка
  }
}

export function storeLocale(locale: Locale): void {
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    /* см. readStoredLocale — хранилище недоступно, не критично */
  }
}

/**
 * Язык из initData Telegram — НЕ угадывание вроде Accept-Language
 * браузера или geo-IP (от которых сознательно отказался solar-shop,
 * см. landing/src/lib/i18n.ts): `language_code` в Telegram — явная
 * настройка человека в самом Telegram-клиенте, а не выведенное значение.
 * Используется только как НАЧАЛЬНОЕ значение при первом заходе, когда
 * localStorage ещё пуст — явный выбор через переключатель внутри
 * приложения всегда имеет приоритет при последующих заходах.
 */
export function detectTelegramLocale(
  languageCode: string | undefined
): Locale | null {
  if (!languageCode) return null;
  const short = languageCode.slice(0, 2).toLowerCase();
  return isLocale(short) ? short : null;
}

export function initialLocale(languageCode: string | undefined): Locale {
  return (
    readStoredLocale() ?? detectTelegramLocale(languageCode) ?? defaultLocale
  );
}
