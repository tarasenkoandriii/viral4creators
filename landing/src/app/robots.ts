import type { MetadataRoute } from 'next';
import { headers } from 'next/headers';
import { SITE_URL } from '../lib/content';
import { GREETING_SITE_URL, isGreetingHost } from '../lib/greeting-host';

/**
 * `robots.txt` (TODO §II.5) — ссылки на карты сайта. Конвенция Next App
 * Router: `robots.ts` в `app/` автоматически отдаётся на `/robots.txt`.
 *
 * Этап 3 поздравлений: маршрут стал зависеть от хоста, и это не
 * украшение. Поддомен `greeting.…` отдаёт ту же сборку, что и главный
 * домен, — если бы он продолжал печатать здесь `Sitemap:
 * https://welcome.…/sitemap.xml`, он объявлял бы своей карту сайта
 * ЧУЖОГО хоста. Кросс-хостовые карты сайта поисковики принимают только
 * при подтверждённом владении обоими адресами и в остальных случаях
 * игнорируют — то есть поддомен остался бы без карты вовсе.
 *
 * `headers()` делает маршрут динамическим (в отличие от статического
 * `robots.txt` до этой правки). Цена — один рендер на запрос вместо
 * закешированного файла; для документа в три строки это несопоставимо
 * дешевле, чем ошибка индексации.
 */
export default function robots(): MetadataRoute.Robots {
  const host = headers().get('host');
  if (isGreetingHost(host)) {
    return {
      rules: { userAgent: '*', allow: '/' },
      sitemap: [`${GREETING_SITE_URL}/sitemap.xml`],
    };
  }
  return {
    rules: { userAgent: '*', allow: '/' },
    sitemap: [`${SITE_URL}/sitemap.xml`, `${SITE_URL}/sitemap-news.xml`],
  };
}
