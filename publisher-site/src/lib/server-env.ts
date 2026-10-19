import { landingVisitsUrlOf } from './landing-visits';

/**
 * Связь с публичным API (проектный документ §13.7). Значения проверены и
 * впечены `next.config.js` при сборке; здесь — чтение по литералам
 * `process.env.X` (подстановка Next) и второй замок на случай сборки в
 * обход конфига. Модуль только серверный: ключ и адрес
 * клиентские компоненты получают пропсами.
 */
export interface PublisherEnv {
  apiOrigin: string;
  publicKey: string;
  /** Первый ключ индексации (§13.3): `PUBLISHER_INDEXING=on` в production. */
  indexingOn: boolean;
  /**
   * Адрес счётчика «Посещения лендингов» платформы (§13.5, Р-IA-FXA-1) или
   * `''` — канал выключен. Включается ещё и site-config (live + согласие):
   * `landingVisitsTarget`.
   */
  landingVisitsUrl: string;
}

export function publisherEnv(): PublisherEnv {
  const apiOrigin = (process.env.PUBLISHER_API_ORIGIN ?? '').replace(/\/$/, '');
  const publicKey = process.env.PUBLISHER_PUBLIC_KEY ?? '';
  if (!apiOrigin || !/^https?:\/\/[^/]+$/.test(apiOrigin)) {
    throw new Error('PUBLISHER_API_ORIGIN не задан или не origin (см. publisher-site/.env.example)');
  }
  if (!/^pp_[A-Za-z0-9]{24}$/.test(publicKey)) {
    throw new Error('PUBLISHER_PUBLIC_KEY не задан или не `pp_…` (см. publisher-site/.env.example)');
  }
  const landingVisitsUrl = landingVisitsUrlOf({
    PUBLISHER_LANDING_VISITS_URL: process.env.PUBLISHER_LANDING_VISITS_URL,
    VERCEL: process.env.VERCEL,
    VERCEL_ENV: process.env.VERCEL_ENV,
  });
  return { apiOrigin, publicKey, indexingOn: process.env.PUBLISHER_INDEXING === 'on', landingVisitsUrl };
}
