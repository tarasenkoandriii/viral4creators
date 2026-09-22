import { NextRequest, NextResponse } from 'next/server';
import { defaultLocale, locales, LOCALE_COOKIE } from './lib/i18n';
import { GREETING_SITE_URL, isGreetingHost } from './lib/greeting-host';
import { TUTORIAL_SITE_URL, isTutorialHost } from './lib/tutorial-host';
import { SITE_URL } from './lib/content';

/**
 * Локаль-редирект (этап 55) — паттерн перенесён из архитектуры блога
 * проекта "solar shop" (тот же приём: middleware дописывает префикс
 * `/ru/...`, cookie хранит явный выбор человека).
 *
 * `/legal/*` и `/embed`-подобные служебные пути НАМЕРЕННО исключены из
 * локализации регэкспом ниже: юридические документы (Договор оферты,
 * Условия использования) — это официальные тексты с проверкой юристом
 * перед публикацией, и машинный перевод такого текста без review — это
 * не снятие языкового барьера, а юридический риск (см. lib/i18n.ts).
 * Поэтому /legal/offer и /legal/terms-of-use остаются одной редакцией
 * (русской) для всех локалей интерфейса, без сегмента [locale] вообще.
 *
 * Этап 58: `/feed` (RSS, TODO §II.4) исключён по той же причине, что и
 * `/legal`, — это динамический путь без точки (`/feed/[category]`), и
 * общий паттерн `.*\.` его не ловит, в отличие от `sitemap-news.xml` /
 * `feed.xml` (у обоих есть точка в имени — они уже исключаются этим же
 * общим паттерном и отдельного упоминания не требуют, как, впрочем, и
 * `sitemap.xml`/`robots.txt` ниже, которые тем не менее оставлены
 * явно — для читаемости).
 *
 * Этап 3 поздравлений: сюда же добавилось ветвление по ХОСТУ — до
 * локали, а не после. Порядок здесь не стилистический: если сперва
 * дописать `/ru`, а потом смотреть на хост, то на поддомене придётся
 * разбирать уже переписанный путь, и обе логики начнут спорить за одну
 * строку. Сначала решаем, какой это сайт, потом — на каком он языке.
 *
 * Этап 60 (ТЗ §40): `/video` (публичная страница ролика,
 * `app/video/[id]/page.tsx`) — по той же причине, что и `/legal`, но
 * не про юридический риск, а про то, что переводить тут нечего: снимок
 * страницы хранит ОДНУ зафиксированную локаль автора на момент публикации
 * (`SharedVideoPage.locale`), и страница сама решает, на каком языке
 * говорить (`getDictionary(page.locale)`), а не читает её из URL.
 */
export const config = {
  matcher: [
    '/((?!_next|legal|feed|video|icon|favicon.ico|robots.txt|sitemap.xml|.*\\..*).*)',
  ],
};

/**
 * Годится ли значение как адрес, на который можно увести посетителя.
 *
 * Появилось после боевой проверки этапа 3: `SITE_URL` на проде не задан,
 * и дефолт `http://localhost:3003` из `content.ts` превращал редирект в
 * ссылку на машину самого посетителя. Отдельная функция, а не `!==`
 * с одной строкой: дефолт может смениться, а признак «это локальный
 * адрес» — нет.
 */
function isReachableOrigin(raw: string): boolean {
  try {
    const { protocol, hostname } = new URL(raw);
    if (protocol !== 'https:' && protocol !== 'http:') return false;
    return hostname !== 'localhost' && hostname !== '127.0.0.1';
  } catch {
    return false;
  }
}

/**
 * Мини-лендинги на собственных поддоменах.
 *
 * Таблица, а не две одинаковые ветки: поддоменов стало два
 * (поздравления и обучалки по сайту заказчика), правило для них ОДНО, и
 * записанное дважды оно разъезжается на третьем. `slug` — путь той же
 * страницы на главном домене; именно он схлопывается в корень
 * поддомена и с него же уводит редирект в обратную сторону.
 */
const SUBDOMAIN_SITES: ReadonlyArray<{
  matches: (host: string | null) => boolean;
  siteUrl: string;
  slug: string;
}> = [
  { matches: isGreetingHost, siteUrl: GREETING_SITE_URL, slug: 'greetings' },
  { matches: isTutorialHost, siteUrl: TUTORIAL_SITE_URL, slug: 'site-tutorial' },
];

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const host = request.headers.get('host');
  const site = SUBDOMAIN_SITES.find((candidate) => candidate.matches(host));

  const pathnameHasLocale = locales.some(
    (locale) => pathname.startsWith(`/${locale}/`) || pathname === `/${locale}`,
  );

  if (site) {
    // На поддомене каноническое место страницы — `/<locale>`, и только
    // оно. Явный `/<locale>/<slug>` схлопывается в него редиректом,
    // чтобы не оставалось двух живых адресов одной страницы.
    const explicit = locales.find(
      (locale) => pathname === `/${locale}/${site.slug}`,
    );
    if (explicit) {
      const url = request.nextUrl.clone();
      url.pathname = `/${explicit}`;
      return NextResponse.redirect(url, 308);
    }
    // `/<locale>` показывает страницу этого поддомена — rewrite, не
    // redirect: адрес в строке браузера должен остаться коротким, это и
    // есть canonical.
    const locale = locales.find((l) => pathname === `/${l}`);
    if (locale) {
      const url = request.nextUrl.clone();
      url.pathname = `/${locale}/${site.slug}`;
      return NextResponse.rewrite(url);
    }
    // Всё остальное на поддомене — чужие страницы главного сайта (блог,
    // «как это работает») и страница СОСЕДНЕГО поддомена. Отдавать их
    // здесь значило бы завести второй адрес каждой из них; уводим на
    // главный домен, а он уже уведёт дальше, если надо.
    //
    // Но только если адрес главного домена ВООБЩЕ задан. `SITE_URL`
    // имеет дефолт `http://localhost:3003` «для dev-стенда», и на
    // первом же боевом запросе выяснилось, что в проде он не задан
    // вовсе: редирект уводил посетителя на localhost, то есть в никуда.
    // Отдать страницу на поддомене — это дубль, неприятно; увести
    // человека на мёртвый адрес — это сломанный сайт. Из двух зол
    // выбираем обратимое.
    if (pathnameHasLocale && isReachableOrigin(SITE_URL)) {
      return NextResponse.redirect(
        new URL(`${SITE_URL}${pathname}${request.nextUrl.search}`),
        308,
      );
    }
  }

  if (pathnameHasLocale) {
    // На ГЛАВНОМ домене `/<locale>/<slug>` — не отдельная страница, а
    // второй адрес той же самой. Канон живёт на поддомене, сюда же
    // ведут внутренние ссылки, поэтому редирект постоянный.
    for (const candidate of SUBDOMAIN_SITES) {
      const locale = locales.find(
        (l) => pathname === `/${l}/${candidate.slug}`,
      );
      if (locale) {
        return NextResponse.redirect(
          new URL(`${candidate.siteUrl}/${locale}`),
          308,
        );
      }
    }
    return NextResponse.next();
  }

  // Единственный источник, который считается ЯВНЫМ выбором человека, —
  // cookie, выставленная переключателем языка. Без неё — всегда
  // defaultLocale, независимо от языка браузера или страны по IP: тот же
  // принцип "не гадать", что уже применён в аналогичном месте solar-shop
  // (см. комментарий в lib/i18n.ts).
  const cookieLocale = request.cookies.get(LOCALE_COOKIE)?.value;
  const locale = cookieLocale && (locales as readonly string[]).includes(cookieLocale) ? cookieLocale : defaultLocale;

  const url = request.nextUrl.clone();
  url.pathname = `/${locale}${pathname === '/' ? '' : pathname}`;
  return NextResponse.redirect(url);
}
