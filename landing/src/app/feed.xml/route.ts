import { NextRequest, NextResponse } from 'next/server';
import { defaultLocale, isLocale } from '../../lib/i18n';
import { listAllBlogPosts, BLOG_REVALIDATE_SECONDS } from '../../lib/blog-api';
import { SITE_URL, SITE_NAME } from '../../lib/content';
import { buildRssXml } from '../../lib/rss';

/**
 * Общая RSS-лента (TODO §II.4) — все опубликованные записи блога по
 * умолчанию на `defaultLocale`, либо на языке из `?locale=`. Отдельный
 * файл на категорию — `feed/[category]/route.ts`.
 */
export const revalidate = BLOG_REVALIDATE_SECONDS;

export async function GET(request: NextRequest) {
  const localeParam = request.nextUrl.searchParams.get('locale');
  const locale = localeParam && isLocale(localeParam) ? localeParam : defaultLocale;

  const posts = await listAllBlogPosts(locale);
  const channelLink = `${SITE_URL}/${locale}/blog`;

  const xml = buildRssXml({
    posts,
    locale,
    channelTitle: `${SITE_NAME} — блог`,
    channelDescription: 'Разбор свежих рекламных роликов, отобранных Gemini.',
    channelLink,
    selfUrl: `${SITE_URL}/feed.xml${localeParam ? `?locale=${locale}` : ''}`,
  });

  return new NextResponse(xml, {
    headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' },
  });
}
