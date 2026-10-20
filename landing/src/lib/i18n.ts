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
 * defaultLocale = 'ru' сохраняется для внутренних fallback словарей.
 * Корень сайта: явная cookie, затем страна Vercel и Accept-Language; без совпадения — en (20.10.2026).
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

/**
 * Направление письма для `<html dir>`. Все пять языков — слева направо,
 * но таблица, а не константа `'ltr'` в разметке: `Record<Locale, …>` не
 * даст добавить шестую локаль (скажем, арабскую), не решив за неё и это.
 */
export const LOCALE_DIR: Record<Locale, 'ltr' | 'rtl'> = {
  ru: 'ltr',
  uk: 'ltr',
  en: 'ltr',
  de: 'ltr',
  es: 'ltr',
};

export function isLocale(value: string): value is Locale {
  return (locales as readonly string[]).includes(value);
}

/** Имя cookie, в которую переключатель языка пишет явный выбор человека. */
export const LOCALE_COOKIE = 'NEXT_LOCALE';



/** Explicit choice, Vercel country, browser language, then English. */
export function visitorLocale(cookie: string | undefined, header: string | null, country?: string | null): Locale {
  if (cookie && (locales as readonly string[]).includes(cookie)) return cookie as Locale;
  const countries: Record<string, string> = {
    UA: 'uk', RU: 'ru', DE: 'de', AT: 'de', LI: 'de',
    ES: 'es', MX: 'es', AR: 'es', BO: 'es', CL: 'es', CO: 'es', CR: 'es',
    CU: 'es', DO: 'es', EC: 'es', SV: 'es', GT: 'es', HN: 'es', NI: 'es',
    PA: 'es', PY: 'es', PE: 'es', UY: 'es', VE: 'es',
    US: 'en', GB: 'en', AU: 'en', NZ: 'en', IE: 'en',
  };
  const regional = countries[country?.trim().toUpperCase() ?? ''];
  if (regional && (locales as readonly string[]).includes(regional)) return regional as Locale;
  const ranked = (header ?? '').split(',').map((part, index) => {
    const [tag, ...params] = part.trim().toLowerCase().split(';');
    const q = params.map(p => p.trim()).find(p => p.startsWith('q='));
    const weight = q ? Number(q.slice(2)) : 1;
    return { tag: tag.split('-')[0], weight, index };
  }).filter(x => Number.isFinite(x.weight) && x.weight > 0 && x.weight <= 1)
    .sort((a, b) => b.weight - a.weight || a.index - b.index);
  const match = ranked.find(x => (locales as readonly string[]).includes(x.tag));
  return match ? match.tag as Locale : 'en';
}
