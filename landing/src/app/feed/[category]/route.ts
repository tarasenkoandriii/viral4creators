import { NextRequest, NextResponse } from 'next/server';
import { defaultLocale, isLocale } from '../../../lib/i18n';
import { listBlogPosts, BLOG_REVALIDATE_SECONDS } from '../../../lib/blog-api';
import { SITE_URL, SITE_NAME } from '../../../lib/content';
import { buildRssXml } from '../../../lib/rss';

/**
 * Потатегорийная RSS-лента (TODO §II.4: "реклама вообще не интересна
 * никому, реклама косметики за неделю — конкретной аудитории"). Категория
 * — свободный текст (см. PublicBlogQueryDto.category в бэкенде, там нет
 * enum), поэтому она просто передаётся в query публичного API как есть.
 *
 * Динамический сегмент без точки в пути — middleware.ts исключает
 * `/feed` явно (как и `/legal`), иначе редиректнул бы на `/ru/feed/...`.
 */
export const revalidate = BLOG_REVALIDATE_SECONDS;

export async function GET(request: NextRequest, { params }: { params: { category: string } }) {
  const localeParam = request.nextUrl.searchParams.get('locale');
  const locale = localeParam && isLocale(localeParam) ? localeParam : defaultLocale;
  const category = decodeURIComponent(params.category);

  const page = await listBlogPosts({ locale, category, pageSize: 50 });
  const posts = page?.items ?? [];
  const channelLink = `${SITE_URL}/${locale}/blog`;

  const xml = buildRssXml({
    posts,
    locale,
    channelTitle: `${SITE_NAME} — ${category}`,
    channelDescription: `Разбор свежих рекламных роликов в категории «${category}», отобранных Gemini.`,
    channelLink,
    selfUrl: `${SITE_URL}/feed/${params.category}${localeParam ? `?locale=${locale}` : ''}`,
  });

  return new NextResponse(xml, {
    headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' },
  });
}
