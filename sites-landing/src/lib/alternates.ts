import type { Metadata } from 'next';
import { locales, X_DEFAULT_LOCALE, type Locale } from './i18n';
import { siteUrl } from './site-url';

/**
 * `canonical` + `hreflang` одной функцией (порт `landing/src/lib/alternates.ts`,
 * уроки Ф-1, Ф-4, Ф-5 — ТЗ §0).
 *
 *  - Ф-1: `alternates` в странице ЗАМЕЩАЕТ `languages` из layout. Поэтому
 *    каждая страница зовёт эту функцию сама и получает весь набор разом;
 *    в layout `alternates` нет вовсе — нечего замещать.
 *  - Ф-4: только абсолютные адреса. В `landing/` при незаданном
 *    `SITE_URL` функция молча переходила на относительные (`alternates.ts:40-41`);
 *    здесь `siteUrl()` бросает, а прод-сборку останавливает `next.config.js`.
 *  - `x-default` — параметр (по умолчанию `en`), а не `defaultLocale`
 *    (аудит 01.10: в `landing/` это был `'ru'`), и ведёт на реальную
 *    страницу локали, не на корень с редиректом.
 *  - Ф-5: canonical на каждой странице — utm-метки не плодят дубли.
 *
 * `path` — путь страницы БЕЗ локали: `''` для главной, `/assistant/pricing`.
 */
export function pathFor(locale: Locale, path: string): string {
  return `/${locale}${path}`;
}

export function localeAlternates(
  path: string,
  current: Locale,
  opts: { xDefault?: Locale; env?: NodeJS.ProcessEnv; only?: readonly Locale[] } = {},
): NonNullable<Metadata['alternates']> {
  const origin = siteUrl(opts.env);
  const abs = (l: Locale) => `${origin}${pathFor(l, path)}`;
  // Страница не во всех локалях (документация — uk/en): hreflang только на
  // существующие версии, `x-default` — на `en`, если она есть.
  const list = opts.only ?? locales;
  const xDefault = opts.xDefault ?? (list.includes(X_DEFAULT_LOCALE) ? X_DEFAULT_LOCALE : list[0]);
  return {
    canonical: abs(current),
    languages: {
      ...Object.fromEntries(list.map((l) => [l, abs(l)])),
      'x-default': abs(xDefault),
    },
  };
}
