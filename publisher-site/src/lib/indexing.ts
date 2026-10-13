import type { Metadata } from 'next';
import type { SiteConfigView } from './api-types';

/**
 * Индексация — только при двух ключах (проектный документ §13.3):
 * `PUBLISHER_INDEXING=on` (впекается `next.config.js` только в production
 * Vercel) И `site-config.indexable` (гейт `public_publish` открыт, хост
 * `SITE_URL` подтверждён). Это значение — для `<meta name="robots">` и
 * `robots.txt`; заголовок `X-Robots-Tag` ставит `next.config.js` при сборке.
 */
export function isIndexable(cfg: Pick<SiteConfigView, 'indexable'>, indexingOn: boolean): boolean {
  return indexingOn && cfg.indexable === true;
}

export function robotsMeta(indexable: boolean): Metadata['robots'] {
  return indexable ? { index: true, follow: true } : { index: false, follow: false };
}

/** Служебные страницы (404, 410, результат формы) — всегда noindex. */
export const NOINDEX: Metadata['robots'] = { index: false, follow: false };
