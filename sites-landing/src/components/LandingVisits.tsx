'use client';

import { usePathname } from 'next/navigation';
import { useEffect } from 'react';

// First-party aggregate views only. No URL, query, referrer, cookie or visitor ID.
let lastPath = '';
export function landingFor(host: string, path: string, landingsByHost: Record<string, string>): string | null {
  const landing = landingsByHost[host];
  if (!landing) return null;
  const page = path.split('/').filter(Boolean)[1];
  if (page === 'stories') return null;
  if (landing !== 'main') return landing;
  if (page === 'greetings') return 'greeting';
  if (page === 'tutorial' || page === 'site-tutorial') return 'tutorial';
  return 'main';
}
export function sendLandingVisit(endpoint: string, landing: string, locale: string) {
  void fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ eventId: crypto.randomUUID(), landing, locale }),
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
      const key = landing + ':' + locale + ':' + pathname;
      if (key === lastPath || document.visibilityState !== 'visible') return;
      lastPath = key;
      sendLandingVisit(endpoint, landing, locale);
    };
    send();
    document.addEventListener('visibilitychange', send);
    return () => document.removeEventListener('visibilitychange', send);
  }, [pathname, locale, endpoint, landingsByHost, enabled]);
  return null;
}
