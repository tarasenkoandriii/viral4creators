/**
 * Мультиязычность маркетплейса — пять языков: ru/uk/en/de/es. Тот же
 * паттерн, что уже в проде у landing/src/lib/i18n.ts (locales +
 * defaultLocale + [locale]-сегмент + middleware + словари JSON),
 * перенесён сюда без изменений в подходе — только свой набор словарей
 * под контент маркетплейса.
 *
 * defaultLocale = 'ru' — по той же причине, что и в landing: весь текущий
 * контент площадки написан по-русски, и без явного выбора cookie
 * поведение для всех существующих ссылок не должно меняться ни на бит.
 *
 * /embed/[id] (§20 №5) и /feed.xml, /feed.json (§20 №11) сознательно
 * ЖИВУТ ВНЕ [locale] — см. middleware.ts. Причины разные: у embed нет
 * смысла тащить локаль в код для встраивания на чужой сайт (усложнило бы
 * сниппет ради контента, который в основном и так — названия работ на
 * языке, который выбрал сам исполнитель); лента — один общий поток на
 * все языки, как у большинства маленьких RSS/JSON-фидов.
 */

export const locales = ['ru', 'uk', 'en', 'de', 'es'] as const;
export type Locale = (typeof locales)[number];

export const defaultLocale: Locale = 'ru';

/** Название языка на нём самом — для переключателя. */
export const LOCALE_LABELS: Record<Locale, string> = {
  ru: 'Русский',
  uk: 'Українська',
  en: 'English',
  de: 'Deutsch',
  es: 'Español',
};

/** Для Open Graph/`lang`-атрибутов, где нужен машиночитаемый locale-тег. */
export const OG_LOCALES: Record<Locale, string> = {
  ru: 'ru_RU',
  uk: 'uk_UA',
  en: 'en_US',
  de: 'de_DE',
  es: 'es_ES',
};

export function isLocale(value: string): value is Locale {
  return (locales as readonly string[]).includes(value);
}

/** Имя cookie, в которую переключатель языка пишет явный выбор человека. */
export const LOCALE_COOKIE = 'NEXT_LOCALE';
