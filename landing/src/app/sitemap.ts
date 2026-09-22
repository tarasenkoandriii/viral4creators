import type { MetadataRoute } from 'next';
import { locales } from '../lib/i18n';
import { BLOG_REVALIDATE_SECONDS, listAllBlogPosts } from '../lib/blog-api';
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
 *
 * Аудит лендинга 2026-09-22 — две находки, исправленные здесь.
 *
 * 1. **`lastModified: now` на статических страницах — неверная дата, а
 *    не приблизительная.** `new Date()` вычислялся в момент рендера
 *    sitemap, то есть каждый деплой объявлял изменёнными ВСЕ страницы,
 *    включая те, которых деплой не касался. Честного значения для них
 *    у лендинга нет: текст лежит в словарях репозитория, даты их правки
 *    в рантайме не видно, а дата билда — это не дата изменения текста.
 *    Поэтому поле просто не выводится: `<lastmod>` в спецификации
 *    sitemap необязателен, и его отсутствие — корректное «не знаю»,
 *    в отличие от даты, которая неверна.
 *
 * 2. **Блог в sitemap устаревал до следующего деплоя.** Записи
 *    читаются через `listAllBlogPosts` (fetch с `next: { revalidate }`),
 *    но у самого маршрута sitemap срока жизни не было — он запекался на
 *    билде и держался, пока не случится новый. Новая запись появлялась
 *    на витрине (у неё `revalidate` есть) и не появлялась в sitemap.
 *    Интервал здесь тот же, что у самого блога: держать sitemap свежее
 *    его источника смысла нет.
 */
export const revalidate = BLOG_REVALIDATE_SECONDS;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const entries: MetadataRoute.Sitemap = [];

  for (const locale of locales) {
    entries.push(
      { url: `${SITE_URL}/${locale}` },
      { url: `${SITE_URL}/${locale}/blog` },
      // Этап 79 (doc/LANDING-HOW-IT-WORKS-VISUAL-SPEC.md §3.4) —
      // выделенная страница «Как это работает», того же уровня, что
      // /blog.
      { url: `${SITE_URL}/${locale}/how-it-works` }
    );
  }

  entries.push({ url: `${SITE_URL}/legal/offer` }, { url: `${SITE_URL}/legal/terms-of-use` });

  // Один и тот же slug фигурирует под каждой локалью (страница отдаёт
  // оригинал + честную пометку, если перевода ещё нет — см.
  // isRequestedLocale в blog-api.ts) — та же логика, что уже использует
  // generateStaticParams в app/[locale]/blog/[slug]/page.tsx.
  for (const locale of locales) {
    const posts = await listAllBlogPosts(locale);
    for (const post of posts) {
      entries.push({
        url: `${SITE_URL}/${locale}/blog/${post.slug}`,
        // Единственная дата, которая у лендинга есть по-настоящему.
        // Запись без `publishedAt` идёт без `lastModified` — по той же
        // причине, что и статические страницы выше.
        ...(post.publishedAt ? { lastModified: new Date(post.publishedAt) } : {}),
      });
    }
  }

  return entries;
}
