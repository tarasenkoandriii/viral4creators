/**
 * Согласие на рассылку подборки удачных роликов через Telegram-бота (ТЗ
 * §42, этап 63) — тонкие функции над общим `api` (services/api.ts), тем
 * же приёмом, что billing-api.ts.
 *
 * Все три маршрута за `TelegramIdentityGuard` на бэкенде (слать в
 * Telegram можно только тому, у кого есть identity) — анонимный путь
 * ловит 401, экран показывает `isUnauthorized()` (см. projects-api.ts).
 */

import { api } from './api';
import type { MarketingConsentStatus } from '../types';

function unwrap<T>(res: { data?: T }, what: string): T {
  if (res.data === undefined) throw new Error(`Пустой ответ: ${what}`);
  return res.data;
}

export async function getMarketingConsent(): Promise<MarketingConsentStatus> {
  return unwrap(
    await api.get<MarketingConsentStatus>('/me/marketing-consent'),
    'marketing consent'
  );
}

export async function acceptMarketingConsent(): Promise<MarketingConsentStatus> {
  return unwrap(
    await api.post<MarketingConsentStatus>('/me/marketing-consent'),
    'marketing consent'
  );
}

export async function revokeMarketingConsent(): Promise<MarketingConsentStatus> {
  return unwrap(
    await api.post<MarketingConsentStatus>('/me/marketing-consent/revoke'),
    'marketing consent'
  );
}
