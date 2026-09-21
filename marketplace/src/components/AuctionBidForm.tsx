'use client';

import { useEffect, useState } from 'react';
import { ApiError, getAuctionListingLive, placeBid, startAuctionCheckout } from '../lib/client-api';
import { useDictionary } from '../lib/dictionary-context';
import { convertForDisplay, type AuctionCurrencyValue } from '../lib/fx-rates';
import { hasFreshPublisher, subscribeHighestBid } from '../lib/live-bid-bus';

/** Как часто опрашивать лот на предмет чужих ставок — компромисс между свежестью и нагрузкой на бэкенд, не тот же revalidate, что у серверного рендера страницы (клиентский поллинг бьёт напрямую, минуя кеш Next.js). */
const POLL_INTERVAL_MS = 8000;

/**
 * Настоящие торги (ТЗ на маркетплейс §22.1) — резерв не проверяется на
 * этом шаге (только на сервере при закрытии, §22, «Три разные цены»):
 * здесь достаточно перебить текущую лучшую ставку. buyNowPrice — ставка
 * на эту сумму сразу завершает торги на сервере (WON).
 *
 * Аудит-фикс (свежесть ставки): initialHighestBid — только снимок с
 * момента серверного рендера страницы. Раньше это состояние обновлялось
 * ТОЛЬКО после ставки самого зрителя — если кто-то другой ставил, пока
 * страница уже открыта, зритель не видел новую сумму без обновления
 * страницы. Теперь компонент сам себя опрашивает — тем же публичным
 * GET /auctions/:id, что уже отдаёт сервер при первой загрузке.
 *
 * Аудит-фикс по ходу написания: публичная /auctions/:id отдаёт 404, как
 * только лот перестаёт быть ACTIVE (§22, «не должна оставлять мёртвые
 * публичные ссылки») — значит показать кнопку оплаты ПОСЛЕ перезагрузки
 * страницы для выигранного лота негде, эта же страница уже не откроется.
 * Чек-аут после «купить сейчас» показывается сразу по локальному
 * состоянию, без обращения к серверу за статусом лота. Тот же 404 от
 * поллинга теперь используется и для ОБРАТНОГО случая — лот закрылся,
 * пока зритель на странице, но выиграл не он (см. endedByOthers ниже).
 * Обычные торги, выигранные не этим зрителем, по-прежнему приводят его
 * на страницу «мои ставки/выигрыши» отдельно (см. /my-bids), не сюда.
 */
export function AuctionBidForm({
  listingId,
  initialHighestBid,
  startingPrice,
  buyNowPrice,
  payoutCurrency,
  estimateCurrency,
}: {
  listingId: string;
  initialHighestBid: number | null;
  startingPrice: number;
  buyNowPrice: number | null;
  /** Валюта, которую выбрал продавец — ставки и сравнение всегда в ней (§22, «Три разные цены»). */
  payoutCurrency: AuctionCurrencyValue;
  /** Заполнена, только если отличается от payoutCurrency — informational-оценка для зрителя из другой страны, не более. */
  estimateCurrency: AuctionCurrencyValue | null;
}) {
  const { dict } = useDictionary();
  const [highestBid, setHighestBid] = useState(initialHighestBid);
  const [amount, setAmount] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [wonByMe, setWonByMe] = useState(false);
  const [endedByOthers, setEndedByOthers] = useState(false);
  const [checkoutForm, setCheckoutForm] = useState<{ url: string; fields: Record<string, string> } | null>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [checkingOut, setCheckingOut] = useState(false);

  const floor = Math.max(startingPrice, highestBid ?? 0);
  const estimate = (amount: number): string | null =>
    estimateCurrency ? ` (≈ ${convertForDisplay(amount, payoutCurrency, estimateCurrency)} ${estimateCurrency})` : null;

  useEffect(() => {
    // Останавливается сам, как только для ЭТОГО зрителя всё решено —
    // дальше опрашивать нечего и незачем.
    if (wonByMe || endedByOthers) return;

    const poll = async () => {
      if (document.hidden) return; // не тратим запросы на фоновую вкладку
      // Аудит L-2: на BLITZ-лоте ту же сумму уже опрашивает плеер эфира —
      // вдвое чаще. Пока он публикует, своего запроса не делаем вовсе:
      // два независимых опроса одного числа расходились между собой до
      // восьми секунд, и оба были видны на экране одновременно.
      if (hasFreshPublisher(listingId)) return;
      const fresh = await getAuctionListingLive(listingId).catch(() => undefined);
      if (fresh === undefined) return; // сетевой сбой — тихо пробуем на следующем тике
      if (fresh === null) {
        setEndedByOthers(true);
        return;
      }
      setHighestBid(fresh.highestBidAmount);
    };

    void poll(); // первый запрос сразу, а не через POLL_INTERVAL_MS (аудит L-8)
    const timer = setInterval(() => void poll(), POLL_INTERVAL_MS);
    // Возврат на вкладку обновляет сумму немедленно (аудит L-9).
    const onVisible = () => {
      if (!document.hidden) void poll();
    };
    document.addEventListener('visibilitychange', onVisible);
    // Значение от плеера эфира — источник правды, пока он жив.
    const unsubscribe = subscribeHighestBid(listingId, (update) => {
      setHighestBid(update.amount);
    });
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      unsubscribe();
    };
  }, [listingId, wonByMe, endedByOthers]);

  const submitBid = async (bidAmount: number) => {
    setSubmitting(true);
    setError(null);
    setSuccess(false);
    try {
      const bid = await placeBid(listingId, bidAmount);
      setHighestBid(bid.amount);
      setAmount('');
      setSuccess(true);
      if (buyNowPrice != null && bidAmount >= buyNowPrice) {
        setWonByMe(true);
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 400) setError(dict.auctions.bidErrorTooLow);
      else if (e instanceof ApiError && e.status === 401) setError(dict.errors.notLoggedIn);
      else if (e instanceof ApiError && e.status === 404) setEndedByOthers(true); // закрылся между опросами, прямо на попытке поставить
      else setError(dict.auctions.bidErrorGeneric);
    } finally {
      setSubmitting(false);
    }
  };

  const handleCheckout = async () => {
    setCheckingOut(true);
    setCheckoutError(null);
    try {
      const result = await startAuctionCheckout(listingId);
      if (result.wayforpayFormUrl && result.wayforpayFields) {
        setCheckoutForm({ url: result.wayforpayFormUrl, fields: result.wayforpayFields });
      } else {
        setCheckoutError(dict.auctions.checkoutError);
      }
    } catch {
      setCheckoutError(dict.auctions.checkoutError);
    } finally {
      setCheckingOut(false);
    }
  };

  if (checkoutForm) {
    // WayForPay ждёт обычный form-POST со своими полями, не fetch (см.
    // BillingService.startAuctionCheckout — wayforpayFields уже готовая форма).
    return (
      <form method="POST" action={checkoutForm.url}>
        {Object.entries(checkoutForm.fields).map(([key, value]) => (
          <input key={key} type="hidden" name={key} value={value} />
        ))}
        <button type="submit" className="mp-cta">
          {dict.myAuctions.payNowButton}
        </button>
      </form>
    );
  }

  if (wonByMe) {
    return (
      <div>
        <p className="mp-advice-box">{dict.auctions.wonNotice}</p>
        <button type="button" className="mp-cta" onClick={() => void handleCheckout()} disabled={checkingOut}>
          {checkingOut ? dict.brief.submitting : dict.auctions.payNowButton}
        </button>
        {checkoutError && <p style={{ color: '#e05252' }}>{checkoutError}</p>}
      </div>
    );
  }

  if (endedByOthers) {
    return <p className="mp-hint">{dict.auctions.endedBannerText}</p>;
  }

  return (
    <div className="mp-form">
      <div className="mp-field">
        <label htmlFor="bidAmount">
          {dict.auctions.bidPlaceholder} ({dict.auctions.currentBidLabel.toLowerCase()}: {highestBid ?? startingPrice} {payoutCurrency}
          {estimate(highestBid ?? startingPrice)})
        </label>
        <input
          id="bidAmount"
          type="number"
          min={floor + 0.01}
          step="0.01"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder={String(floor)}
        />
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button
          type="button"
          className="mp-cta"
          disabled={submitting || !amount}
          onClick={() => void submitBid(Number(amount))}
        >
          {submitting ? dict.auctions.bidding : dict.auctions.bidButton}
        </button>
        {buyNowPrice != null && (
          <button type="button" className="mp-cta-secondary" disabled={submitting} onClick={() => void submitBid(buyNowPrice)}>
            {dict.auctions.buyNowButton} ({buyNowPrice} {payoutCurrency}
            {estimate(buyNowPrice)})
          </button>
        )}
      </div>
      {error && <p style={{ color: '#e05252' }}>{error}</p>}
      {success && !wonByMe && <p style={{ color: 'var(--mp-accent)' }}>{dict.auctions.bidSuccess}</p>}
    </div>
  );
}
