import type { Metadata } from 'next';
import { OG_LOCALES, type Locale } from './i18n';

/**
 * `openGraph` + `twitter` одной парой (порт `landing/src/lib/social-meta.ts`,
 * уроки Ф-3 и Ф-6/Ф-7 — ТЗ §0): `twitter` не наследуется от чужой страницы,
 * `og:image` есть на каждой.
 *
 * Отличие от порта: имя сайта (`og:site_name`) — параметр (бренд из
 * `brand.ts`), а картинка адресуется ключом страницы, а не «сайтом»
 * (`main`/`greetings`), — у нас OG на страницу × локаль (§8.5).
 */
export function socialMeta(opts: {
  title: string;
  description: string;
  /** Абсолютный адрес страницы; он же `og:url`. */
  url: string;
  locale: Locale;
  /** Абсолютный адрес картинки 1200×630. */
  image: string;
  siteName: string;
  type?: 'website' | 'article';
}): Pick<Metadata, 'openGraph' | 'twitter'> {
  const images = [{ url: opts.image, width: 1200, height: 630, alt: opts.title }];
  return {
    openGraph: {
      title: opts.title,
      description: opts.description,
      url: opts.url,
      siteName: opts.siteName,
      locale: OG_LOCALES[opts.locale],
      type: opts.type ?? 'website',
      images,
    },
    twitter: {
      card: 'summary_large_image',
      title: opts.title,
      description: opts.description,
      images,
    },
  };
}

/**
 * Адрес статической OG-карточки страницы и локали. Файлы собирает
 * `scripts/og-cards.mjs` в `public/og/<page>-<locale>.jpg`; что все
 * нужные файлы есть, проверяет `scripts/seo.test.ts`.
 */
export function ogImageUrl(origin: string, page: string, locale: Locale): string {
  return `${origin}/og/${page}-${locale}.jpg`;
}
