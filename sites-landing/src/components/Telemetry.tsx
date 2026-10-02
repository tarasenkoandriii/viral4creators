'use client';

import { useEffect } from 'react';
import { configureTracking, track } from '../lib/track';

/**
 * События §10 на каждой странице: `page_view` и клики по CTA. CTA
 * размечаются в серверной разметке атрибутами (`data-cta="hero"`,
 * `data-tma="wd"`) — без клиентского JS на каждую кнопку: один
 * делегированный обработчик здесь.
 */
export function Telemetry({ endpoint }: { endpoint: string | null }) {
  useEffect(() => {
    configureTracking({ endpoint });
    if (!endpoint) return;
    track('page_view');
    const onClick = (ev: MouseEvent) => {
      const el = (ev.target as Element | null)?.closest?.('[data-cta],[data-tma]');
      if (!el) return;
      const place = el.getAttribute('data-cta') ?? undefined;
      const tma = el.getAttribute('data-tma');
      if (tma) track('tma_click', place ? { payload: tma, place } : { payload: tma });
      else if (place) track('cta_click', { place });
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [endpoint]);
  return null;
}
