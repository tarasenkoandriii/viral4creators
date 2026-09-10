/**
 * Общий сборщик RSS 2.0 (этап 58, TODO §II.4) — используется и общей
 * лентой (`app/feed.xml/route.ts`), и потатегорийной
 * (`app/feed/[category]/route.ts`), и `sitemap-news.xml` переиспользует
 * отсюда только `escapeXml` (у news-sitemap другой корневой элемент,
 * общего канала там нет).
 *
 * Лента — не отдельный сбор данных (TODO §II.4: "технически надстройка
 * над очередью блога... отдельного сбора данных не требует"): порог
 * "высокая оценка Gemini" уже применён на бэкенде на этапе создания
 * черновика (`BLOG_MIN_SCORE_TO_DRAFT`, backend/src/config/configuration.ts)
 * — то, что дошло до публикации через модерацию, этот порог уже прошло.
 * Поэтому здесь просто отдаётся тот же публичный список постов, что и
 * витрине блога, без повторной фильтрации по score (которого к тому же
 * нет в публичном API — см. PublicBlogPostListItem).
 */
import type { PublicBlogPostListItem } from './blog-api';

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function buildRssXml(opts: {
  posts: PublicBlogPostListItem[];
  locale: string;
  channelTitle: string;
  channelDescription: string;
  /** Публичная страница блога — куда ведёт `<link>` канала. */
  channelLink: string;
  /** Абсолютный URL самой ленты — для `<atom:link rel="self">`. */
  selfUrl: string;
}): string {
  const { posts, locale, channelTitle, channelDescription, channelLink, selfUrl } = opts;

  const items = posts
    .filter((post) => post.publishedAt)
    .sort(
      (a, b) => new Date(b.publishedAt as string).getTime() - new Date(a.publishedAt as string).getTime()
    )
    // Предохранитель на размер файла — агрегаторам не нужна вся история,
    // только свежее (тот же принцип, что у sitemap-news, но не двое суток,
    // а количество: RSS традиционно отдаёт "последние N", а не диапазон дат).
    .slice(0, 50)
    .map((post) => {
      const itemUrl = `${channelLink}/${post.slug}`;
      return `
    <item>
      <title>${escapeXml(post.title)}</title>
      <link>${itemUrl}</link>
      <guid isPermaLink="true">${itemUrl}</guid>
      <pubDate>${new Date(post.publishedAt as string).toUTCString()}</pubDate>
      <category>${escapeXml(post.category)}</category>
      <description>${escapeXml(post.category)}</description>
    </item>`;
    })
    .join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(channelTitle)}</title>
    <link>${channelLink}</link>
    <description>${escapeXml(channelDescription)}</description>
    <language>${locale}</language>
    <atom:link href="${selfUrl}" rel="self" type="application/rss+xml" />${items}
  </channel>
</rss>`;
}
