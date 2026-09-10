import type { MetadataRoute } from 'next';
import { SITE_URL } from '../lib/content';

/**
 * `robots.txt` (TODO §II.5) — ссылки на оба sitemap-файла: основной и
 * новостной. Конвенция Next App Router: `robots.ts` в `app/`
 * автоматически отдаётся на `/robots.txt`.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: '*', allow: '/' },
    sitemap: [`${SITE_URL}/sitemap.xml`, `${SITE_URL}/sitemap-news.xml`],
  };
}
