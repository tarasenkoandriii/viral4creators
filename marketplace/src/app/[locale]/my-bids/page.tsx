'use client';

/**
 * Закрывает реальный, названный вслух пробел (не завуалированный):
 * победитель ОБЫЧНЫХ торгов (не «купить сейчас») узнавал о выигрыше
 * только по дедлайну, через крон — а /auctions/:id к тому моменту уже
 * 404-ится (§22, «не должна оставлять мёртвые публичные ссылки»).
 * Теперь дополнительно уведомляется в Telegram (AuctionService.
 * notifyWinner) со ссылкой сюда.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ApiError, getMyBids, MyBidView, startAuctionCheckout } from '../../../lib/client-api';
import { useDictionary } from '../../../lib/dictionary-context';
import type { Locale } from '../../../lib/i18n';

export default function MyBidsPage({ params }: { params: { locale: Locale } }) {
  const { dict } = useDictionary();
  const [bids, setBids] = useState<MyBidView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checkingOutId, setCheckingOutId] = useState<string | null>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [checkoutForm, setCheckoutForm] = useState<{ listingId: string; url: string; fields: Record<string, string> } | null>(null);

  useEffect(() => {
    getMyBids()
      .then(setBids)
      .catch((e) => setError(e instanceof ApiError && e.status === 401 ? dict.errors.notLoggedIn : dict.errors.generic));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleCheckout = async (listingId: string) => {
    setCheckingOutId(listingId);
    setCheckoutError(null);
    try {
      const result = await startAuctionCheckout(listingId);
      if (result.wayforpayFormUrl && result.wayforpayFields) {
        setCheckoutForm({ listingId, url: result.wayforpayFormUrl, fields: result.wayforpayFields });
      } else {
        setCheckoutError(dict.auctions.checkoutError);
      }
    } catch {
      setCheckoutError(dict.auctions.checkoutError);
    } finally {
      setCheckingOutId(null);
    }
  };

  const statusLabel = (status: MyBidView['listingStatus']) =>
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
      <h1>{dict.myBids.heading}</h1>
      {error && <p style={{ color: '#e05252' }}>{error}</p>}
      {bids && bids.length === 0 && <p className="mp-empty">{dict.myBids.empty}</p>}

      {bids && bids.length > 0 && (
        <div className="mp-grid">
          {bids.map((bid) => (
            <div key={bid.listingId} className="mp-creator-card">
              <span className="mp-creator-card-name">{bid.title}</span>
              <span className="mp-creator-card-price">
                {dict.myBids.myBidLabel}: {bid.myBidAmount}
              </span>

              {bid.isWinner && bid.paymentPaid && <span className="mp-pill">{dict.myBids.paidBadge}</span>}

              {bid.isWinner && !bid.paymentPaid && checkoutForm?.listingId === bid.listingId && (
                <form method="POST" action={checkoutForm.url}>
                  {Object.entries(checkoutForm.fields).map(([key, value]) => (
                    <input key={key} type="hidden" name={key} value={value} />
                  ))}
                  <button type="submit" className="mp-cta">
                    {dict.myAuctions.payNowButton}
                  </button>
                </form>
              )}

              {bid.isWinner && !bid.paymentPaid && checkoutForm?.listingId !== bid.listingId && (
                <>
                  <p className="mp-advice-box">{dict.auctions.wonNotice}</p>
                  <button
                    type="button"
                    className="mp-cta"
                    disabled={checkingOutId === bid.listingId}
                    onClick={() => void handleCheckout(bid.listingId)}
                  >
                    {checkingOutId === bid.listingId ? dict.brief.submitting : dict.auctions.payNowButton}
                  </button>
                </>
              )}

              {!bid.isWinner && <span className="mp-pill">{statusLabel(bid.listingStatus)}</span>}

              {bid.listingStatus === 'ACTIVE' && (
                <Link href={`/${params.locale}/auctions/${bid.listingId}`} className="mp-cta-secondary">
                  {dict.myAuctions.viewOnAuction}
                </Link>
              )}
            </div>
          ))}
        </div>
      )}
      {checkoutError && <p style={{ color: '#e05252' }}>{checkoutError}</p>}
    </>
  );
}
