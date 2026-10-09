import { NextRequest, NextResponse } from 'next/server';
import { defaultLocale, isLocale } from '../../lib/i18n';
import { listAllBlogPosts } from '../../lib/blog-api';
import { SITE_URL, SITE_NAME } from '../../lib/content';
import { buildRssXml } from '../../lib/rss';

/**
 * Общая RSS-лента (TODO §II.4) — все опубликованные записи блога по
 * умолчанию на `defaultLocale`, либо на языке из `?locale=`. Отдельный
 * файл на категорию — `feed/[category]/route.ts`.
 */
// Литерал, а не `BLOG_REVALIDATE_SECONDS`: Next 15 читает конфиг сегмента
// статически, по исходнику, и импортированную константу отвергает ошибкой
// сборки (Next 14 брал значение из модуля). Равенство константе держит
// scripts/segment-config.test.ts.
export const revalidate = 900;

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
