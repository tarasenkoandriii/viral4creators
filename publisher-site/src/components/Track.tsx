'use client';

import { usePathname } from 'next/navigation';
import { useEffect } from 'react';
import type { ConsentState } from '@/lib/api-types';
import {
  contentSlugOf,
  eventPathOf,
  pageAttribution,
  referrerHostOf,
  safeSessionStorage,
  type AnalyticsStorage,
} from '@/lib/attribution';
import { sendLandingVisit } from '@/lib/landing-visits';
import { buildEvent, sendEvent } from '@/lib/track';

/**
 * Трекер (§13.5; бюджет ≤ 2 КБ): `content_view` — один раз на просмотр
 * страницы (после гидратации и на каждом клиентском переходе), `cta_click`
 * — по клику на элемент с `data-cta` (делегирование: сами CTA — серверная
 * разметка без JS). Ключ, адрес API, режим хранения и `consentState`
 * приходят пропсами из site-config, клиент env не читает. `visitsEndpoint` —
 * адрес счётчика «Посещения лендингов» платформы или `null`: решение
 * (env + `mode=live` + согласие) принимает сервер (`landingVisitsTarget`,
 * §13.5, Р-IA-FXA-1); при `null` второй запрос не уходит.
 */
interface Props {
  visitsEndpoint: string | null;
  apiOrigin: string;
  publicKey: string;
  analyticsStorage: AnalyticsStorage;
  consentState: ConsentState;
}

let lastView = '';
/** `referrerHost` — только у первого просмотра документа: при клиентском переходе `document.referrer` прежний (аудит S3-4). */
let referrerSent = false;

export default function Track({ apiOrigin, publicKey, analyticsStorage, consentState, visitsEndpoint }: Props) {
  const pathname = usePathname();

  useEffect(() => {
    const cfg = { apiOrigin, publicKey, consentState };
    const send = (name: 'content_view' | 'cta_click') => {
      const loc = window.location;
      const attribution = pageAttribution(analyticsStorage, safeSessionStorage(), loc);
      const firstView = name === 'content_view' && !referrerSent;
      if (firstView) referrerSent = true;
      const body = buildEvent(
        cfg,
        name,
        {
          path: eventPathOf(loc.pathname),
          contentSlug: contentSlugOf(loc.pathname),
          referrerHost: firstView ? referrerHostOf(document.referrer, loc.host) : undefined,
          attribution,
        },
        crypto.randomUUID(),
      );
      sendEvent(apiOrigin, body, {
        sendBeacon: navigator.sendBeacon ? (u, d) => navigator.sendBeacon(u, d) : undefined,
        fetch: (u, i) => fetch(u, i),
      });
    };
    const view = pathname + window.location.search;
    if (view !== lastView) {
      lastView = view;
      send('content_view');
      if (visitsEndpoint) sendLandingVisit(visitsEndpoint);
    }
    const onClick = (e: MouseEvent) => {
      const el = (e.target as Element | null)?.closest?.('[data-cta]');
      if (el) send('cta_click');
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [pathname, apiOrigin, publicKey, analyticsStorage, consentState, visitsEndpoint]);

  return null;
}
