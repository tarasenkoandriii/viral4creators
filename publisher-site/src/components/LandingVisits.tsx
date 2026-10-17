"use client";

import { usePathname } from 'next/navigation';
import { useEffect } from 'react';

// First-party aggregate views only. No URL, query, referrer, cookie or visitor ID.
const ENDPOINT = 'https://backend-iota-ruddy-57.vercel.app/api/public/landing-visits';
let lastPath = '';
export function landingFor(host: string, path: string): string | null {
  if (host === 'greeting.viral4creators.app') return 'greeting';
  if (host === 'tutorial.viral4creators.app') return 'tutorial';
  if (host === 'assist.viral4creators.app') return 'assistant';
  if (host === 'ai-publisher.org' || host === 'www.ai-publisher.org') return 'publisher';
  if (!['welcome.viral4creators.app','wellcome.viral4creators.app','viral-landing-seven.vercel.app'].includes(host)) return null;
  const page = path.split('/').filter(Boolean)[1];
  if (page === 'stories') return null;
  if (page === 'greetings') return 'greeting';
  if (page === 'tutorial' || page === 'site-tutorial') return 'tutorial';
  return 'main';
}
export default function LandingVisits() {
  const pathname = usePathname();
  useEffect(() => {
    const send = () => {
    const landing = landingFor(window.location.hostname, pathname);
    const locale = document.documentElement.lang.toLowerCase();
    if (!landing || !['ru','uk','en','de','es'].includes(locale)) return;
    const key = landing + ':' + locale + ':' + pathname;
    if (key === lastPath || document.visibilityState !== 'visible') return;
    lastPath = key;
    const body = JSON.stringify({ eventId: crypto.randomUUID(), landing, locale });
    void fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body, credentials: 'omit', keepalive: true, referrerPolicy: 'no-referrer' }).catch(() => {
        // A single network retry uses the same event ID; storage is idempotent.
        void fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body, credentials: 'omit', keepalive: true, referrerPolicy: 'no-referrer' }).catch(() => {});
      });
    };
    send();
    document.addEventListener('visibilitychange', send);
    return () => document.removeEventListener('visibilitychange', send);
  }, [pathname]);
  return null;
}
