'use client';

import { usePathname } from 'next/navigation';
import { useEffect } from 'react';

// Aggregate views: only bounded declared labels; never send URL, query, referrer or visitor ID.
let lastPath = '';
export function landingFor(host: string, path: string, landingsByHost: Record<string, string>): string | null {
  const landing = landingsByHost[host];
  if (!landing) return null;
  const page = path.split('/').filter(Boolean)[1];
  if (landing === 'story-tales')
    return path.split('/').filter(Boolean).length <= 2 && (!page || page === 'stories') ? 'story-tales' : null;
  if (page === 'stories') return null;
  if (landing === 'assistant' && page === 'hands-free') return 'hands-free';
  if (landing === 'assistant' && page === 'qa') return 'qa';
  if (landing !== 'main') return landing;
  if (page === 'greetings') return 'greeting';
  if (page === 'tutorial' || page === 'site-tutorial') return 'tutorial';
  return 'main';
}
export function visitDimensions(search: string, hash: string) {
  const values = new URLSearchParams(search).getAll('utm_source');
  return {
    source: values.length === 1 && values[0] === 'linkedin' ? 'linkedin' : 'unknown',
    traffic: hash === '#v4c-test' ? 'test' : 'unmarked',
  };
}
export function sendLandingVisit(
  endpoint: string,
  landing: string,
  locale: string,
  dimensions?: ReturnType<typeof visitDimensions>,
) {
  void fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ eventId: crypto.randomUUID(), landing, locale, ...dimensions }),
    credentials: 'omit',
    keepalive: true,
    referrerPolicy: 'no-referrer',
  }).catch(() => {});
}

export default function LandingVisits({
  locale,
  enabled,
  endpoint,
  landingsByHost,
}: {
  locale: string;
  enabled: boolean;
  endpoint: string;
  landingsByHost: Record<string, string>;
}) {
  const pathname = usePathname();
  useEffect(() => {
    if (!enabled) return;
    const send = () => {
      const landing = landingFor(window.location.hostname, pathname, landingsByHost);

      if (!landing || !['ru', 'uk', 'en', 'de', 'es'].includes(locale)) return;
      const dimensions = visitDimensions(window.location.search, window.location.hash);
      const key = landing + ':' + locale + ':' + pathname + ':' + dimensions.source + ':' + dimensions.traffic;
      if (key === lastPath || document.visibilityState !== 'visible') return;
      lastPath = key;
      sendLandingVisit(endpoint, landing, locale, dimensions);
    };
    send();
    document.addEventListener('visibilitychange', send);
    return () => document.removeEventListener('visibilitychange', send);
  }, [pathname, locale, endpoint, landingsByHost, enabled]);
  return null;
}
