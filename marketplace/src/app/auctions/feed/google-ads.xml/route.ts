import { NextResponse } from 'next/server';
import { getAuctionListings, PROFILE_REVALIDATE_SECONDS } from '../../../../lib/api';
import { defaultLocale } from '../../../../lib/i18n';

/**
 * Товарный фид для Google Ads (ТЗ на маркетплейс §22, «Google Ads для
 * блиц-лотов») — только BLITZ: разница в комиссии (30% против 20% у
 * STANDARD) финансирует именно это продвижение, у STANDARD его нет и
 * ему в этом фиде делать нечего.
 *
 * Стандартный namespace Google Shopping (`base.google.com/ns/1.0`) —
 * тот же формат, который реально принимают Google Ads/Merchant Center,
 * а не самодельная схема: если кто-то настроит приём этого фида, он
 * действительно заработает, а не только формально будет существовать.
 *
 * Этот файл — только ДАННЫЕ фида (Этап 4). Сам вызов Google Ads API,
 * который создаёт/ставит на паузу кампании и заполняет
 * AuctionListing.googleAdsCampaignId, теперь реализован отдельно —
 * `backend/src/modules/auction/google-ads.service.ts` (Этап 5),
 * вызывается из `AuctionService` при переходе лота в/из ACTIVE. Это XML
 * ниже с ним не связан напрямую (у Performance Max без Merchant Center
 * ассеты кампании — текст/картинка/URL, не строки фида), но остаётся
 * полезным экспортом для ручной настройки Merchant Center оператором,
 * если он у площадки когда-нибудь появится.
 *
 * price = buyNowPrice, если задана, иначе startingPrice — в момент
 * публикации ставок может ещё не быть вообще, рекламировать нечего
 * показывать кроме стартовой или мгновенной цены (то же решение,
 * что уже принято для sitemap-news.xml).
 */
export const revalidate = PROFILE_REVALIDATE_SECONDS;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3004';

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
    const price = listing.buyNowPrice ?? listing.startingPrice;
    const link = `${SITE_URL}/${defaultLocale}/auctions/${listing.id}`;

    items.push(`
    <item>
      <g:id>${escapeXml(listing.id)}</g:id>
      <title>${escapeXml(listing.title)}</title>
      <link>${link}</link>
      ${listing.thumbnailUrl ? `<g:image_link>${escapeXml(listing.thumbnailUrl)}</g:image_link>` : ''}
      <g:price>${price.toFixed(2)} ${listing.payoutCurrency}</g:price>
      <g:availability>in_stock</g:availability>
      <g:expiration_date>${listing.expiresAt}</g:expiration_date>
    </item>`);
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
  <channel>
    <title>viral4creators — блиц-лоты аукциона</title>
    <link>${SITE_URL}/${defaultLocale}/auctions</link>${items.join('')}
  </channel>
</rss>`;

  return new NextResponse(xml, {
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
  });
}
