import Link from 'next/link';
import { headers } from 'next/headers';
import { getAuctionListings } from '../../../lib/api';
import { getDictionary } from '../../../lib/get-dictionary';
import type { Locale } from '../../../lib/i18n';
import { EndedAuctionBanner } from '../../../components/EndedAuctionBanner';
import { COUNTRY_CURRENCY, convertForDisplay, type AuctionCurrencyValue } from '../../../lib/fx-rates';

/**
 * Постоянный раздел витрины (ТЗ на маркетплейс §22.1) — не разовое
 * событие под конкретного заказчика. Только ACTIVE-лоты, тот же принцип,
 * что у /collections (§20 №20).
 */
export default async function AuctionsPage({
  params,
  searchParams,
}: {
  params: { locale: Locale };
  searchParams: { ended?: string };
}) {
  const dict = getDictionary(params.locale);
  const listings = await getAuctionListings();
  // Та же информационная оценка, что на карточке лота (§22, предложение
  // «валюта той страны, которая в заголовке vercel») — не авторитетная,
  // только подсказка зрителю из другой страны.
  const viewerCountry = headers().get('x-vercel-ip-country');
  const viewerCurrency = viewerCountry ? COUNTRY_CURRENCY[viewerCountry] : undefined;
  const estimateFor = (amount: number, currency: AuctionCurrencyValue): string | null =>
    viewerCurrency && viewerCurrency !== currency
      ? ` (≈ ${convertForDisplay(amount, currency, viewerCurrency)} ${viewerCurrency})`
      : null;

  return (
    <>
      <EndedAuctionBanner show={searchParams.ended === '1'} />
      <h1>{dict.auctions.heading}</h1>
      <p className="mp-hint">
        {dict.auctions.subheading} · <Link href={`/${params.locale}/my-auctions`}>{dict.auctions.myListingsLink}</Link>
        {' · '}
        <Link href={`/${params.locale}/my-bids`}>{dict.myBids.heading}</Link>
      </p>

      {listings.length === 0 ? (
        <p className="mp-empty">{dict.auctions.empty}</p>
      ) : (
        <div className="mp-portfolio-grid">
          {listings.map((item) => {
            const amount = item.highestBidAmount ?? item.startingPrice;
            const label = item.highestBidAmount != null ? dict.auctions.currentBidLabel : dict.auctions.startingPriceLabel;
            return (
              <Link key={item.id} href={`/${params.locale}/auctions/${item.id}`} className="mp-portfolio-item" style={{ textDecoration: 'none' }}>
                {/* eslint-disable-next-line jsx-a11y/media-has-caption -- превью без звука, как остальные превью проекта */}
                <video src={item.videoUrl} muted playsInline poster={item.thumbnailUrl ?? undefined} />
                <div className="mp-portfolio-item-footer" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
                  <strong>{item.title}</strong>
                  <span style={{ display: 'flex', gap: 6 }}>
                    {item.auctionType === 'BLITZ' && <span className="mp-pill">{dict.auctions.blitzBadge}</span>}
                    {item.isExclusiveBundle && <span className="mp-pill">{dict.auctions.exclusiveBadge}</span>}
                  </span>
                  <span className="mp-creator-card-price">
                    {label}: {amount} {item.payoutCurrency}
                    {estimateFor(amount, item.payoutCurrency)}
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </>
  );
}
