/**
 * Мультиязычность маркетплейса — пять языков: ru/uk/en/de/es. Тот же
 * паттерн, что уже в проде у landing/src/lib/i18n.ts (locales +
 * defaultLocale + [locale]-сегмент + middleware + словари JSON),
 * перенесён сюда без изменений в подходе — только свой набор словарей
 * под контент маркетплейса.
 *
 * defaultLocale = 'ru' — внутренний fallback словарей. Для посетителя:
 * явная локаль URL, cookie, страна Vercel, язык браузера, затем en.
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
