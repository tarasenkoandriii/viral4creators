import { NextResponse } from 'next/server';
import { getAuctionListings, PROFILE_REVALIDATE_SECONDS } from '../../lib/api';
import { defaultLocale } from '../../lib/i18n';

/**
 * `sitemap-news.xml` по схеме Google News (ТЗ на маркетплейс §22,
 * «Публичные страницы и sitemap») — ОТДЕЛЬНЫЙ файл от sitemap.ts, как
 * того требует схема (namespace news.google.com/schemas/sitemap-news/0.9,
 * которую типовой генератор MetadataRoute.Sitemap не умеет) — тот же
 * приём, что уже есть в landing/src/app/sitemap-news.xml/route.ts.
 *
 * Только BLITZ: у Google News Sitemap ограничение по свежести около 48
 * часов, что один в один совпадает с окном блица (§22, «Тип аукциона»)
 * — STANDARD с его 3–7 днями для этого формата не подходит.
 *
 * publication_date — не приближение: BLITZ длится РОВНО 48 часов
 * (backend BLITZ_DURATION_MS), поэтому момент, когда лот стал ACTIVE,
 * точно вычисляется как expiresAt минус эти же 48 часов. Честного
 * созданного/опубликованного поля в публичном PublicAuctionListingView
 * нет, но здесь оно и не нужно — для BLITZ дата выводится точно, без
 * догадки.
 */
export const revalidate = PROFILE_REVALIDATE_SECONDS;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3004';
const SITE_NAME = 'viral4creators';
const BLITZ_DURATION_MS = 48 * 60 * 60 * 1000;

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export async function GET() {
  const listings = await getAuctionListings();
  const items: string[] = [];

  for (const listing of listings) {
    if (listing.auctionType !== 'BLITZ') continue;
    const activatedAt = new Date(new Date(listing.expiresAt).getTime() - BLITZ_DURATION_MS);

    items.push(`
  <url>
    <loc>${SITE_URL}/${defaultLocale}/auctions/${listing.id}</loc>
    <news:news>
      <news:publication>
        <news:name>${escapeXml(SITE_NAME)}</news:name>
        <news:language>${defaultLocale}</news:language>
      </news:publication>
      <news:publication_date>${activatedAt.toISOString()}</news:publication_date>
      <news:title>${escapeXml(listing.title)}</news:title>
    </news:news>
  </url>`);
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">${items.join('')}
</urlset>`;

  return new NextResponse(xml, {
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
  });
}
