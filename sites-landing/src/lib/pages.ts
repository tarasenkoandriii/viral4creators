import type { Metadata } from 'next';
import { BRAND } from '../brand';
import { localeAlternates, pathFor } from './alternates';
import { fmt } from './format';
import { getDictionary } from './get-dictionary';
import type { Locale } from './i18n';
import { ogImageUrl, socialMeta } from './social-meta';
import { siteUrl } from './site-url';

/**
 * Реестр индексируемых страниц — один источник для sitemap, метаданных,
 * OG-карточек и проверок собранного HTML.
 *
 * `updated` — дата последней правки СОДЕРЖАНИЯ страницы (её текстов или
 * данных), а не дата сборки: урок `landing/src/app/sitemap.ts` —
 * «каждый деплой — всё изменилось» хуже, чем отсутствие `lastmod` (§8.1).
 * Правите тексты страницы — правьте дату.
 */
export type PageKey = 'home' | 'assistant' | 'how-it-works' | 'widget' | 'security' | 'pricing' | 'faq' | 'pilot';

export interface PageDef {
  key: PageKey;
  /** Путь без локали: `''` — главная. Слаги нелокализованные (§3.1). */
  path: string;
  updated: string;
  /** Родитель для BreadcrumbList. */
  parent?: PageKey;
}

export const PAGES: readonly PageDef[] = [
  { key: 'home', path: '', updated: '2026-10-02' },
  { key: 'assistant', path: '/assistant', updated: '2026-10-02', parent: 'home' },
  { key: 'how-it-works', path: '/assistant/how-it-works', updated: '2026-10-02', parent: 'assistant' },
  { key: 'widget', path: '/assistant/widget', updated: '2026-10-02', parent: 'assistant' },
  { key: 'security', path: '/assistant/security', updated: '2026-10-02', parent: 'assistant' },
  { key: 'pricing', path: '/assistant/pricing', updated: '2026-10-02', parent: 'assistant' },
  { key: 'faq', path: '/assistant/faq', updated: '2026-10-02', parent: 'assistant' },
  { key: 'pilot', path: '/assistant/pilot', updated: '2026-10-02', parent: 'assistant' },
];

export function page(key: PageKey): PageDef {
  const found = PAGES.find((p) => p.key === key);
  if (!found) throw new Error(`нет страницы ${key}`);
  return found;
}

export function href(locale: Locale, key: PageKey): string {
  return pathFor(locale, page(key).path);
}

/**
 * Метаданные индексируемой страницы: title/description из словаря,
 * canonical + hreflang (+ x-default) абсолютными адресами, OG + Twitter
 * одной парой с картинкой страницы × локали.
 */
export function pageMetadata(key: PageKey, locale: Locale): Metadata {
  const dict = getDictionary(locale);
  const meta = dict.pages[key];
  const title = fmt(meta.title);
  const description = fmt(meta.description);
  const origin = siteUrl();
  const url = `${origin}${href(locale, key)}`;
  return {
    title,
    description,
    alternates: localeAlternates(page(key).path, locale),
    ...socialMeta({
      title,
      description,
      url,
      locale,
      image: ogImageUrl(origin, key, locale),
      siteName: BRAND.name,
    }),
    robots: { index: true, follow: true },
  };
}
