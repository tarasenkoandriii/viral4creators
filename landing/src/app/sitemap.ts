import type { MetadataRoute } from 'next';
import { locales } from '../lib/i18n';
import { listAllBlogPosts } from '../lib/blog-api';
import { SITE_URL } from '../lib/content';

/**
 * `sitemap.xml` (TODO §II.5) — статические страницы + записи блога, по
 * всем пяти локалям. Конвенция Next App Router: файл `sitemap.ts` в
 * `app/` автоматически отдаётся на `/sitemap.xml`, отдельного route.ts
 * не нужно (в отличие от sitemap-news.xml — там нужна не-стандартная
 * схема с `<news:...>`, которую этот генератор не умеет).
 *
 * Правовые страницы (`/legal/*`) намеренно вне [locale] (см.
 * middleware.ts) — одна редакция на все локали, включены один раз.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();
  const entries: MetadataRoute.Sitemap = [];

  for (const locale of locales) {
    entries.push(
      { url: `${SITE_URL}/${locale}`, lastModified: now },
      { url: `${SITE_URL}/${locale}/blog`, lastModified: now },
      // Этап 79 (doc/LANDING-HOW-IT-WORKS-VISUAL-SPEC.md §3.4) —
      // выделенная страница «Как это работает», того же уровня, что
      // /blog.
      { url: `${SITE_URL}/${locale}/how-it-works`, lastModified: now }
    );
  }

  entries.push(
    { url: `${SITE_URL}/legal/offer`, lastModified: now },
    { url: `${SITE_URL}/legal/terms-of-use`, lastModified: now }
  );

  // Один и тот же slug фигурирует под каждой локалью (страница отдаёт
  // оригинал + честную пометку, если перевода ещё нет — см.
  // isRequestedLocale в blog-api.ts) — та же логика, что уже использует
  // generateStaticParams в app/[locale]/blog/[slug]/page.tsx.
  for (const locale of locales) {
    const posts = await listAllBlogPosts(locale);
    for (const post of posts) {
      entries.push({
        url: `${SITE_URL}/${locale}/blog/${post.slug}`,
        lastModified: post.publishedAt ? new Date(post.publishedAt) : now,
      });
    }
  }

  return entries;
}
