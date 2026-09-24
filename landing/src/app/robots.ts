import type { MetadataRoute } from 'next';
import { headers } from 'next/headers';
import { SITE_URL } from '../lib/content';
import { GREETING_SITE_URL, isGreetingHost } from '../lib/greeting-host';
import { TUTORIAL_SITE_URL, isTutorialHost } from '../lib/tutorial-host';

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
 *
 * Этап 134: `/r/` закрыт для обхода на всех трёх хостах. Страница
 * приглашения и сама отдаёт `noindex` (`app/r/[code]/page.tsx`), но
 * `Disallow` дешевле: это личная ссылка одного человека, и без него
 * робот сначала СХОДИТ по каждой — то есть накрутит чужой `visitCount`
 * (§5.2) ровно тем обходом, который всё равно ничего не проиндексирует.
 * На превью в мессенджере это не влияет: его рисует не поисковик.
 */
const DISALLOW_REFERRAL = ['/r/'];
export default function robots(): MetadataRoute.Robots {
  const host = headers().get('host');
  if (isGreetingHost(host)) {
    return {
      rules: { userAgent: '*', allow: '/', disallow: DISALLOW_REFERRAL },
      sitemap: [`${GREETING_SITE_URL}/sitemap.xml`],
    };
  }
  if (isTutorialHost(host)) {
    return {
      rules: { userAgent: '*', allow: '/', disallow: DISALLOW_REFERRAL },
      sitemap: [`${TUTORIAL_SITE_URL}/sitemap.xml`],
    };
  }
  return {
    rules: { userAgent: '*', allow: '/', disallow: DISALLOW_REFERRAL },
    sitemap: [`${SITE_URL}/sitemap.xml`, `${SITE_URL}/sitemap-news.xml`],
  };
}
