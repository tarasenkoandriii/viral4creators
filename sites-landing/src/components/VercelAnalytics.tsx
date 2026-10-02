'use client';

import { Analytics } from '@vercel/analytics/next';
import { analyticsBeforeSend } from '../lib/analytics-url';

/**
 * Vercel Web Analytics с вырезанными query/якорем (`lib/analytics-url.ts`):
 * функцию `beforeSend` нельзя передать из серверного `HtmlDocument`, поэтому
 * обёртка — клиентская.
 */
export function VercelAnalytics() {
  return <Analytics beforeSend={analyticsBeforeSend} />;
}
