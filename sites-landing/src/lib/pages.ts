import type { Metadata } from 'next';
import { BRAND } from '../brand';
import { localeAlternates, pathFor } from './alternates';
import { fmt } from './format';
import { getDictionary } from './get-dictionary';
import { locales, type Locale } from './i18n';
import { PLATFORMS, type PlatformSlug } from './platforms';
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
export type DocsKey = 'docs' | 'docs-js-api' | 'docs-goals' | 'docs-csp';
export type PageKey =
  | 'home'
  | 'assistant'
  | 'how-it-works'
  | 'widget'
  | 'try'
  | 'bot'
  | 'integrations'
  | `integrations-${PlatformSlug}`
  | DocsKey
  | 'security'
  | 'pricing'
  | 'faq'
  | 'pilot';

export interface PageDef {
  key: PageKey;
  /** Путь без локали: `''` — главная. Слаги нелокализованные (§3.1). */
  path: string;
  updated: string;
  /** Родитель для BreadcrumbList. */
  parent?: PageKey;
  /** Локали страницы, если не все: документация — uk/en (§3.13, §11). */
  locales?: readonly Locale[];
  /**
   * OG-карточка, если не своя: платформы и документация — одна на раздел
   * (§8.5: иначе сотни картинок).
   */
  og?: PageKey;
}

/** Документация — uk + en на старте (§11); ru — по спросу. */
export const DOCS_LOCALES = ['uk', 'en'] as const satisfies readonly Locale[];

export const PAGES: readonly PageDef[] = [
  { key: 'home', path: '', updated: '2026-10-02' },
  { key: 'assistant', path: '/assistant', updated: '2026-10-02', parent: 'home' },
  { key: 'how-it-works', path: '/assistant/how-it-works', updated: '2026-10-02', parent: 'assistant' },
  { key: 'widget', path: '/assistant/widget', updated: '2026-10-02', parent: 'assistant' },
  { key: 'try', path: '/assistant/try', updated: '2026-10-02', parent: 'assistant' },
  { key: 'integrations', path: '/assistant/integrations', updated: '2026-10-02', parent: 'assistant' },
  ...PLATFORMS.map((p) => ({
    key: `integrations-${p.slug}` as const,
    path: `/assistant/integrations/${p.slug}`,
    updated: '2026-10-02',
    parent: 'integrations' as const,
    og: 'integrations' as const,
  })),
  { key: 'docs', path: '/docs/assistant', updated: '2026-10-02', parent: 'assistant', locales: DOCS_LOCALES },
  { key: 'docs-js-api', path: '/docs/assistant/js-api', updated: '2026-10-02', parent: 'docs', locales: DOCS_LOCALES, og: 'docs' },
  { key: 'docs-goals', path: '/docs/assistant/goals', updated: '2026-10-02', parent: 'docs', locales: DOCS_LOCALES, og: 'docs' },
  { key: 'docs-csp', path: '/docs/assistant/csp', updated: '2026-10-02', parent: 'docs', locales: DOCS_LOCALES, og: 'docs' },
  { key: 'bot', path: '/assistant/bot', updated: '2026-10-02', parent: 'assistant' },
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

export function pageLocales(key: PageKey): readonly Locale[] {
  return page(key).locales ?? locales;
}

/** Адрес страницы; для страницы без этой локали — первая её локаль (документация для ru → uk). */
export function href(locale: Locale, key: PageKey): string {
  const avail = pageLocales(key);
  return pathFor(avail.includes(locale) ? locale : avail[0], page(key).path);
}

/** Язык цели ссылки, если он не совпадает с языком страницы (для `hrefLang`). */
export function hrefLang(locale: Locale, key: PageKey): Locale | undefined {
  const avail = pageLocales(key);
  return avail.includes(locale) ? undefined : avail[0];
}

/**
 * Метаданные индексируемой страницы: title/description из словаря,
 * canonical + hreflang (+ x-default) абсолютными адресами, OG + Twitter
 * одной парой с картинкой страницы × локали.
 */
export function pageMetadata(key: PageKey, locale: Locale, override?: { title: string; description: string }): Metadata {
  const dict = getDictionary(locale);
  const meta = override ?? (dict.pages as Record<string, { title: string; description: string } | undefined>)[key];
  if (!meta) throw new Error(`нет pages.${key} в словаре ${locale}`);
  const title = fmt(meta.title);
  const description = fmt(meta.description);
  const origin = siteUrl();
  const url = `${origin}${href(locale, key)}`;
  const def = page(key);
  return {
    title,
    description,
    alternates: localeAlternates(def.path, locale, { only: def.locales }),
    ...socialMeta({
      title,
      description,
      url,
      locale,
      image: ogImageUrl(origin, def.og ?? key, locale),
      siteName: BRAND.name,
    }),
    robots: { index: true, follow: true },
  };
}
