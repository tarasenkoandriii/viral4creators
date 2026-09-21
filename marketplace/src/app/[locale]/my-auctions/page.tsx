'use client';

/**
 * Управление заявками исполнителя на аукцион (ТЗ на маркетплейс §22.1)
 * — постоянная очередь, подать можно сколько угодно кандидатов (лимит
 * только на то, сколько из них одновременно ACTIVE, на стороне сервера).
 *
 * Аудит-находка по ходу написания: бэкенд (AuctionService.create) не
 * проверяет, что у выбранной работы уже нет живой заявки на другой
 * аукцион — технически можно было бы отправить одну и ту же работу
 * дважды. Отфильтровано здесь, на фронте (список для выбора не
 * предлагает уже занятые работы), но это UX-подсказка, не настоящая
 * защита — серверную проверку стоит добавить отдельным фиксом, не
 * тихо считать эту фильтрацию достаточной.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  ApiError,
  AuctionListingView,
  AuctionListingStatusValue,
  AuctionTypeValue,
  AuctionCurrencyValue,
  createAuctionListing,
  getMyAuctionListings,
  getMyPortfolioItems,
  PortfolioItemView,
  withdrawAuctionListing,
} from '../../../lib/client-api';
import { useDictionary } from '../../../lib/dictionary-context';
import type { Locale } from '../../../lib/i18n';

const LIVE_STATUSES: AuctionListingStatusValue[] = ['PENDING_MODERATION', 'QUEUED', 'ACTIVE', 'WON'];

export default function MyAuctionsPage({ params }: { params: { locale: Locale } }) {
  const { dict } = useDictionary();
  const [listings, setListings] = useState<AuctionListingView[] | null>(null);
  const [portfolioItems, setPortfolioItems] = useState<PortfolioItemView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [needsQuiz, setNeedsQuiz] = useState(false);

  const [portfolioItemId, setPortfolioItemId] = useState('');
  const [startingPrice, setStartingPrice] = useState('');
  const [reservePrice, setReservePrice] = useState('');
  const [buyNowPrice, setBuyNowPrice] = useState('');
  const [auctionType, setAuctionType] = useState<AuctionTypeValue>('STANDARD');
  const [payoutCurrency, setPayoutCurrency] = useState<AuctionCurrencyValue>('UAH');
  const [includeBrandManifest, setIncludeBrandManifest] = useState(false);
  /** Антиснайпер (§7.3) — явный чекбокс продавца, не включён по умолчанию. */
  const [antiSnipeEnabled, setAntiSnipeEnabled] = useState(false);
  const [rightsConfirmed, setRightsConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    Promise.all([getMyAuctionListings(), getMyPortfolioItems()])
      .then(([auctions, items]) => {
        setListings(auctions);
        setPortfolioItems(items);
      })
      .catch((e) => {
        if (e instanceof ApiError && e.status === 403) setNeedsQuiz(true);
        else setLoadError(dict.errors.generic);
      });
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await createAuctionListing({
        portfolioItemId,
        rightsConfirmed,
        includeBrandManifest,
        antiSnipeEnabled,
        auctionType,
        payoutCurrency,
        startingPrice: Number(startingPrice),
        reservePrice: reservePrice ? Number(reservePrice) : undefined,
        buyNowPrice: buyNowPrice ? Number(buyNowPrice) : undefined,
      });
      setPortfolioItemId('');
      setRightsConfirmed(false);
      setStartingPrice('');
      setReservePrice('');
      setBuyNowPrice('');
      setIncludeBrandManifest(false);
      setAntiSnipeEnabled(false);
      load();
    } catch {
      setError(dict.myAuctions.errorGeneric);
    } finally {
      setSubmitting(false);
    }
  };

  const handleWithdraw = async (id: string) => {
    if (!window.confirm(dict.myAuctions.withdrawConfirm)) return;
    await withdrawAuctionListing(id).catch(() => undefined);
    load();
  };

  if (needsQuiz) {
    return (
      <p className="mp-empty">
        {dict.errors.needsCreatorProfile} <Link href={`/${params.locale}/become-creator`}>{dict.dashboard.takeQuiz}</Link>
      </p>
    );
  }

  const busyPortfolioItemIds = new Set(
    (listings ?? []).filter((l) => LIVE_STATUSES.includes(l.status)).map((l) => l.portfolioItemId),
  );
  const eligibleItems = (portfolioItems ?? []).filter(
    (item) => item.status === 'PUBLISHED' && !busyPortfolioItemIds.has(item.id),
  );

  const statusLabel = (status: AuctionListingStatusValue) =>
    ({
      PENDING_MODERATION: dict.myAuctions.statusPENDING_MODERATION,
      QUEUED: dict.myAuctions.statusQUEUED,
      ACTIVE: dict.myAuctions.statusACTIVE,
      WON: dict.myAuctions.statusWON,
      EXPIRED: dict.myAuctions.statusEXPIRED,
      REJECTED: dict.myAuctions.statusREJECTED,
      WITHDRAWN: dict.myAuctions.statusWITHDRAWN,
    })[status];

  return (
    <>
      <h1>{dict.myAuctions.heading}</h1>
      {loadError && <p style={{ color: '#e05252' }}>{loadError}</p>}

      <h2>{dict.myAuctions.addHeading}</h2>
      {portfolioItems && eligibleItems.length === 0 ? (
        <p className="mp-empty">{dict.myAuctions.noEligibleItems}</p>
      ) : (
        <form className="mp-form" onSubmit={(e) => void handleSubmit(e)}>
          <div className="mp-field">
            <label htmlFor="portfolioItemId">{dict.myAuctions.selectPortfolioItemLabel}</label>
            <select id="portfolioItemId" value={portfolioItemId} onChange={(e) => setPortfolioItemId(e.target.value)} required>
              <option value="" disabled>
                {dict.myAuctions.selectPortfolioItemPlaceholder}
              </option>
              {eligibleItems.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title}
                </option>
              ))}
            </select>
          </div>

          <div className="mp-field">
            <label htmlFor="payoutCurrency">{dict.myAuctions.payoutCurrencyLabel}</label>
            <select id="payoutCurrency" value={payoutCurrency} onChange={(e) => setPayoutCurrency(e.target.value as AuctionCurrencyValue)}>
              <option value="UAH">UAH — ₴</option>
              <option value="USD">USD — $</option>
              <option value="EUR">EUR — €</option>
            </select>
            <p className="mp-hint">{dict.myAuctions.payoutCurrencyHint}</p>
          </div>

          <div className="mp-field">
            <label htmlFor="startingPrice">{dict.myAuctions.startingPriceLabel}</label>
            <input id="startingPrice" type="number" min={1} value={startingPrice} onChange={(e) => setStartingPrice(e.target.value)} required />
          </div>

          <div className="mp-field">
            <label htmlFor="reservePrice">{dict.myAuctions.reservePriceLabel}</label>
            <input id="reservePrice" type="number" min={0} value={reservePrice} onChange={(e) => setReservePrice(e.target.value)} />
          </div>

          <div className="mp-field">
            <label htmlFor="buyNowPrice">{dict.myAuctions.buyNowPriceLabel}</label>
            <input id="buyNowPrice" type="number" min={0} value={buyNowPrice} onChange={(e) => setBuyNowPrice(e.target.value)} />
          </div>

          <div className="mp-field">
            <label htmlFor="auctionType">{dict.myAuctions.auctionTypeLabel}</label>
            <select id="auctionType" value={auctionType} onChange={(e) => setAuctionType(e.target.value as AuctionTypeValue)}>
              <option value="STANDARD">{dict.myAuctions.standardOption}</option>
              <option value="BLITZ">{dict.myAuctions.blitzOption}</option>
            </select>
          </div>

          <div className="mp-field">
            <label>
              <input type="checkbox" checked={includeBrandManifest} onChange={(e) => setIncludeBrandManifest(e.target.checked)} />{' '}
              {dict.myAuctions.includeBrandManifestLabel}
            </label>
            {includeBrandManifest && <p className="mp-hint">{dict.myAuctions.includeBrandManifestHint}</p>}
          </div>

          <div className="mp-field">
            <label>
              <input type="checkbox" checked={antiSnipeEnabled} onChange={(e) => setAntiSnipeEnabled(e.target.checked)} />{' '}
              {dict.myAuctions.antiSnipeEnabledLabel}
            </label>
            <p className="mp-hint">{dict.myAuctions.antiSnipeEnabledHint}</p>
          </div>

          <div className="mp-field">
            <label>
              <input type="checkbox" checked={rightsConfirmed} onChange={(e) => setRightsConfirmed(e.target.checked)} required />{' '}
              {dict.myAuctions.rightsConfirmedLabel}
            </label>
          </div>

          {error && <p style={{ color: '#e05252' }}>{error}</p>}

          <button className="mp-cta" type="submit" disabled={submitting || !rightsConfirmed}>
            {submitting ? dict.myAuctions.submitting : dict.myAuctions.submit}
          </button>
        </form>
      )}

      <h2>{dict.myAuctions.heading}</h2>
      {listings && listings.length === 0 && <p className="mp-empty">{dict.myAuctions.empty}</p>}
      {listings && listings.length > 0 && (
        <div className="mp-grid">
          {listings.map((listing) => (
            <div key={listing.id} className="mp-creator-card">
              <span className="mp-pill">{statusLabel(listing.status)}</span>
              <span className="mp-creator-card-price">
                {dict.myAuctions.startingPriceLabel}: {listing.startingPrice} {listing.payoutCurrency}
              </span>
              {listing.antiSnipeEnabled && listing.extensions > 0 && (
                <span className="mp-hint">
                  {dict.myAuctions.extensionsCountPrefix} {listing.extensions}
                </span>
              )}
              {listing.rejectionReason && (
                <span className="mp-hint">
                  {dict.myAuctions.rejectionReasonPrefix} {listing.rejectionReason}
                </span>
              )}
              {listing.aiAssessment && (
                <span className="mp-hint">
                  {dict.myAuctions.aiAssessmentPrefix} {listing.aiAssessment}
                </span>
              )}
              {listing.brandManifestAiAudit && (
                <span className="mp-hint">
                  {dict.myAuctions.brandManifestAiAuditPrefix} {listing.brandManifestAiAudit}
                </span>
              )}
              <div style={{ display: 'flex', gap: 8 }}>
                {listing.status === 'ACTIVE' && (
                  <Link href={`/${params.locale}/auctions/${listing.id}`} className="mp-cta-secondary">
                    {dict.myAuctions.viewOnAuction}
                  </Link>
                )}
                {LIVE_STATUSES.includes(listing.status) && listing.status !== 'WON' && (
                  <button type="button" className="mp-cta-secondary" onClick={() => void handleWithdraw(listing.id)}>
                    {dict.myAuctions.withdraw}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
