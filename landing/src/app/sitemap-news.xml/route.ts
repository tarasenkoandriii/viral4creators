import { NextResponse } from 'next/server';
import { locales } from '../../lib/i18n';
import { listAllBlogPosts, BLOG_REVALIDATE_SECONDS } from '../../lib/blog-api';
import { SITE_URL, SITE_NAME } from '../../lib/content';
import { escapeXml } from '../../lib/rss';

/**
 * `sitemap-news.xml` по схеме Google News (TODO §II.5) — ОТДЕЛЬНЫЙ файл
 * от основного `sitemap.ts`, как того требует схема (namespace
 * `news.google.com/schemas/sitemap-news/0.9`, которую типовой генератор
 * `MetadataRoute.Sitemap` не поддерживает — поэтому здесь не `sitemap.ts`
 * с новой сигнатурой, а собственный route.ts с ручной XML-сборкой,
 * ровно как sitemap-news и задуман: отдельный файл, а не смешанный с
 * основным).
 *
 * Только записи последних ДВУХ СУТОК — обязательное условие схемы:
 * Google News индексирует по этому файлу как по потоку свежих
 * публикаций, а не архиву.
 *
 * Честная оговорка (TODO §II.5, см. также doc/PRODUCT-PROJECT-SPEC.md):
 * само наличие этого файла не означает включения в Google News — это
 * отдельная организационная заявка издателя, техническая часть на этом
 * заканчивается.
 */
export const revalidate = BLOG_REVALIDATE_SECONDS;

const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;

export async function GET() {
  const cutoff = Date.now() - TWO_DAYS_MS;
  const items: string[] = [];

  for (const locale of locales) {
    const posts = await listAllBlogPosts(locale);
    for (const post of posts) {
      if (!post.publishedAt) continue;
      const publishedAt = new Date(post.publishedAt);
      if (publishedAt.getTime() < cutoff) continue;

      items.push(`
  <url>
    <loc>${SITE_URL}/${locale}/blog/${post.slug}</loc>
    <news:news>
      <news:publication>
        <news:name>${escapeXml(SITE_NAME)}</news:name>
        <news:language>${locale}</news:language>
      </news:publication>
      <news:publication_date>${publishedAt.toISOString()}</news:publication_date>
      <news:title>${escapeXml(post.title)}</news:title>
    </news:news>
  </url>`);
    }
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">${items.join('')}
</urlset>`;

  return new NextResponse(xml, {
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
  });
}
