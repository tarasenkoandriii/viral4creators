'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useDictionary } from '../lib/dictionary-context';

/**
 * Плашка «аукцион больше не активен» на 30 секунд — мягче голого 404,
 * когда открыли ссылку на уже закрывшийся лот (см. редирект в
 * auctions/[id]/page.tsx). Страница /auctions получает признак через
 * ?ended=1 в searchParams серверным пропом (не useSearchParams()) —
 * достаточно начального значения, отдельная граница Suspense не нужна
 * (в отличие от /brief, которой нужен именно клиентский хук).
 */
export function EndedAuctionBanner({ show }: { show: boolean }) {
  const { dict } = useDictionary();
  const router = useRouter();
  const [visible, setVisible] = useState(show);

  useEffect(() => {
    if (!show) return;
    // Чистим ?ended=1 из адресной строки сразу — обновление страницы не
    // должно показывать плашку заново.
    router.replace(window.location.pathname);
    const timer = setTimeout(() => setVisible(false), 30_000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [show]);

  if (!visible) return null;

  return (
    <div className="mp-advice-box" role="status">
      {dict.auctions.endedBannerText}
    </div>
  );
}
