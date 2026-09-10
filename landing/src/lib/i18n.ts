/**
 * Мультиязычность лендинга (этап 55) — пять языков: ru/uk/en/de/es.
 *
 * Решение и паттерн перенесены из архитектуры блога проекта "solar shop"
 * (referenced by user), где ровно такая же связка — locales/defaultLocale
 * + [locale]-сегмент + middleware + словари JSON — уже работала в проде
 * на Next.js 14 App Router. Здесь она применена к лендингу с нуля:
 * никакой Prisma/API-зависимости у лендинга нет и не появляется — словари
 * статические, собираются в бандл при сборке.
 *
 * defaultLocale = 'ru' — сознательно, не 'en': весь текущий контент
 * лендинга и продукта написан по-русски, и без cookie-выбора (то есть для
 * всех существующих ссылок/закладок на "/") поведение не должно
 * измениться ни на бит.
 *
 * Юридические документы (/legal/offer, /legal/terms-of-use) намеренно
 * ЖИВУТ ВНЕ [locale] — см. middleware.ts. Это реальные договорные тексты
 * («Договор публичной оферты», «Условия использования»), сгенерированные
 * из doc/legal/*.md с явной пометкой «требует проверки юристом перед
 * публикацией» — машинный перевод юридического текста без juridical review
 * добавляет юридический риск, а не убирает языковой барьер. Поэтому они
 * остаются в одной редакции (русской) независимо от выбранного языка
 * интерфейса, пока не появится профессиональный перевод по каждому языку
 * отдельно (см. открытый вопрос в ТЗ §35).
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

/**
 * Полное имя языка по-английски для Open Graph/`lang`-атрибутов там, где
 * нужен машиночитаемый locale-тег, а не подпись для человека.
 */
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
