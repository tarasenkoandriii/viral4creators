import type { MetadataRoute } from 'next';
import { pathFor } from '../lib/alternates';
import { locales, X_DEFAULT_LOCALE } from '../lib/i18n';
import { PAGES } from '../lib/pages';
import { siteUrl } from '../lib/site-url';

/**
 * `sitemap.xml` (§8.1): каждая индексируемая страница × локаль,
 * абсолютные адреса, `alternates` (hreflang) с `x-default`, `lastmod` —
 * дата правки содержания из реестра страниц, а не дата сборки.
 * Юр-черновики (noindex) и страницы результата формы сюда не входят.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const origin = siteUrl();
  return PAGES.flatMap((page) =>
    (page.locales ?? locales).map((locale) => ({
      url: `${origin}${pathFor(locale, page.path)}`,
      lastModified: page.updated,
      alternates: {
        languages: {
          ...Object.fromEntries((page.locales ?? locales).map((l) => [l, `${origin}${pathFor(l, page.path)}`])),
          'x-default': `${origin}${pathFor(X_DEFAULT_LOCALE, page.path)}`,
        },
      },
    })),
  );
}
