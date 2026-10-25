'use client';

import { useEffect } from 'react';
import { onCLS, onINP, onLCP, onFCP, onTTFB } from 'web-vitals';

// Observers live for the document, including StrictMode and SPA remounts.
let observersRegistered = false;

/**
 * Register buffered CWV observers after hydration. Bundle the small collector
 * with the document client code: a dynamic import added a serial request on
 * slow connections. The first-load JS budget includes this dependency.
 */
export function WebVitals() {
  useEffect(() => {
    if (observersRegistered) return;
    observersRegistered = true;
    const send = (metric: { name: string; value: number; rating: string }) => {
      const body = JSON.stringify({ name: metric.name, value: metric.value, rating: metric.rating, path: location.pathname });
      if (!navigator.sendBeacon?.('/api/vitals', new Blob([body], { type: 'application/json' }))) {
        fetch('/api/vitals', { method: 'POST', body, keepalive: true, headers: { 'content-type': 'application/json' } }).catch(() => {});
      }
    };
    onCLS(send);
    onINP(send);
    onLCP(send);
    onFCP(send);
    onTTFB(send);
  }, []);
  return null;
}
