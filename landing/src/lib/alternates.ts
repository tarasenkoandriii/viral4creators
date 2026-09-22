import type { Metadata } from 'next';
import { defaultLocale, locales, type Locale } from './i18n';
import { isReachableOrigin } from './site-origin';

/**
 * `canonical` + `hreflang` для многоязычной страницы.
 *
 * Появилось по находкам Ф-1, Ф-4 и Ф-5 аудита живого лендинга, и каждая
 * из трёх — отдельная ошибка, которую эта функция закрывает разом.
 *
 * **Ф-1: `alternates` ЗАМЕЩАЕТ, а не дополняет.** Страницы поддоменов
 * задавали в своём `generateMetadata` только `alternates: { canonical }`
 * — и тем самым стирали `languages`, унаследованные от
 * `[locale]/layout.tsx`. В выдаче это выглядело так: пять локалей
 * страницы существуют, все открыты к индексации, и ни одна не знает про
 * остальные.
 *
 * **Ф-4: относительные hreflang.** На главном домене они были вида
 * `/ru` — Google требует для hreflang абсолютные адреса и на
 * относительные ругается. Там же `x-default` вёл на `/`, который сам
 * отвечает редиректом: hreflang на редирект — отдельная строка в Search
 * Console.
 *
 * **Ф-5: canonical не было ни на одной странице главного домена.**
 * Дублей по хосту нет (`wellcome.` уходит 307-м), но любая utm-метка
 * создаёт новый адрес той же страницы, и без canonical они конкурируют
 * между собой.
 *
 * Оговорка про абсолютность: если `SITE_URL` не задан и остался
 * localhost-дефолт, абсолютные адреса указывали бы на машину
 * посетителя. Это не гипотеза — так уже было на проде (см.
 * `site-origin.ts`). Поэтому в таком случае возвращаются относительные
 * пути: они хуже для поисковика, но не врут.
 */
export function localeAlternates(
  absoluteUrlFor: (locale: Locale) => string,
  relativePathFor: (locale: Locale) => string,
  current: Locale,
): NonNullable<Metadata['alternates']> {
  const absolute = isReachableOrigin(absoluteUrlFor(current));
  const urlFor = absolute ? absoluteUrlFor : relativePathFor;
  return {
    canonical: urlFor(current),
    languages: {
      ...Object.fromEntries(locales.map((l) => [l, urlFor(l)])),
      // `x-default` — версия для тех, чей язык не совпал ни с одной:
      // это реальная страница локали по умолчанию, а не корень сайта,
      // который отвечает редиректом.
      'x-default': urlFor(defaultLocale),
    },
  };
}
