import type { MetadataRoute } from 'next';
import { siteUrl } from '../lib/site-url';

/**
 * `robots.txt`: всё открыто, кроме служебных маршрутов. Страницы
 * результата формы и юр-черновики закрыты `noindex` в самих страницах
 * (а не `Disallow`: иначе робот не увидит `noindex`).
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: '*', allow: '/', disallow: ['/api/'] },
    sitemap: `${siteUrl()}/sitemap.xml`,
  };
}
