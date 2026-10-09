import { NextRequest, NextResponse } from 'next/server';
import { defaultLocale, isLocale } from '../../../lib/i18n';
import { listBlogPosts } from '../../../lib/blog-api';
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
// Литерал, а не `BLOG_REVALIDATE_SECONDS`: Next 15 читает конфиг сегмента
// статически, по исходнику, и импортированную константу отвергает ошибкой
// сборки (Next 14 брал значение из модуля). Равенство константе держит
// scripts/segment-config.test.ts.
export const revalidate = 900;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ category: string }> },
) {
  const { category: rawCategory } = await params;
  const localeParam = request.nextUrl.searchParams.get('locale');
  const locale = localeParam && isLocale(localeParam) ? localeParam : defaultLocale;
  const category = decodeURIComponent(rawCategory);

  const page = await listBlogPosts({ locale, category, pageSize: 50 });
  const posts = page?.items ?? [];
  const channelLink = `${SITE_URL}/${locale}/blog`;

  const xml = buildRssXml({
    posts,
    locale,
    channelTitle: `${SITE_NAME} — ${category}`,
    channelDescription: `Разбор свежих рекламных роликов в категории «${category}», отобранных Gemini.`,
    channelLink,
    selfUrl: `${SITE_URL}/feed/${rawCategory}${localeParam ? `?locale=${locale}` : ''}`,
  });

  return new NextResponse(xml, {
    headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' },
  });
}
