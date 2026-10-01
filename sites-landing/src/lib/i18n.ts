/**
 * Локали лендинга (ТЗ §11): старт — uk, en, ru; pl и de — после первых
 * EU-пилотов (В-5).
 *
 * Порт `landing/src/lib/i18n.ts` с двумя отличиями:
 *  - `X_DEFAULT_LOCALE` — отдельная константа, а не `defaultLocale`
 *    (§0, аудит 01.10: в `landing/` `x-default` совпадал с `'ru'`). Для
 *    hreflang `x-default` здесь — `en`: версия для тех, чей язык не
 *    совпал ни с одной;
 *  - корень `/` выбирает язык по cookie явного выбора, затем по
 *    `Accept-Language` (§11), а без совпадений — тот же `en`.
 *
 * Юридические черновики — вне `[locale]`, одной редакцией (§3.15): без
 * проверенного юристом перевода машинный перевод юр-текста — риск, а не
 * удобство.
 */

export const locales = ['uk', 'en', 'ru'] as const;
export type Locale = (typeof locales)[number];

/** Куда ведёт `x-default` и корень без подсказок о языке. */
export const X_DEFAULT_LOCALE: Locale = 'en';

export const LOCALE_LABELS: Record<Locale, string> = {
  uk: 'Українська',
  en: 'English',
  ru: 'Русский',
};

/** Короткая подпись в шапке — помещается на 360 px вместе с остальным. */
export const LOCALE_SHORT: Record<Locale, string> = { uk: 'UK', en: 'EN', ru: 'RU' };

export const OG_LOCALES: Record<Locale, string> = {
  uk: 'uk_UA',
  en: 'en_US',
  ru: 'ru_RU',
};

/** Для `Intl` (числа, валюта, даты). */
export const INTL_LOCALES: Record<Locale, string> = {
  uk: 'uk-UA',
  en: 'en-US',
  ru: 'ru-RU',
};

export function isLocale(value: string | undefined | null): value is Locale {
  return !!value && (locales as readonly string[]).includes(value);
}

/** Cookie явного выбора языка (переключатель в шапке). */
export const LOCALE_COOKIE = 'NEXT_LOCALE';

/**
 * Параметр ссылки переключателя: `/<loc>/путь?hl=<loc>`. Middleware
 * пишет по нему cookie выбора и уводит на чистый адрес — переключатель
 * работает без клиентского JS, а дублей адресов не появляется.
 */
export const LOCALE_SWITCH_PARAM = 'hl';

/**
 * Язык для корня `/` по заголовку `Accept-Language` (q-веса учитываются).
 * Совпадение по первичному подтегу: `uk-UA` → `uk`, `ru` → `ru`.
 */
export function localeFromAcceptLanguage(header: string | null | undefined): Locale {
  if (!header) return X_DEFAULT_LOCALE;
  const ranked = header
    .split(',')
    .map((part, index) => {
      const [tag, ...params] = part.trim().split(';');
      const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
      const weight = q ? Number(q.slice(2)) : 1;
      return { tag: tag.trim().toLowerCase(), weight: Number.isFinite(weight) ? weight : 0, index };
    })
    .filter((x) => x.tag && x.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.index - b.index);
  for (const { tag } of ranked) {
    const primary = tag.split('-')[0];
    if (isLocale(primary)) return primary;
  }
  return X_DEFAULT_LOCALE;
}
