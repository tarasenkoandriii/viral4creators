import { NextRequest, NextResponse } from 'next/server';
import { visitorLocale, locales, LOCALE_COOKIE } from './lib/i18n';
import { GREETING_SITE_URL, isGreetingHost } from './lib/greeting-host';
import { TUTORIAL_SITE_URL, isTutorialHost } from './lib/tutorial-host';
import {
  STORIES_REFERRER_POLICY,
  STORIES_ROBOTS,
  STORIES_SITE_URL,
  isStoriesHost,
  isStoriesPath,
} from './lib/stories-host';
import { SITE_URL } from './lib/content';
import { isReachableOrigin } from './lib/site-origin';
import {
  isStoriesIndexable,
  isStoriesOpen,
  storiesLandingMode,
  type StoriesLandingMode,
} from './lib/stories/landing-mode';

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
 *
 * Этап 134 («Условно бесплатный Lite» §5.1): `/r/<код>` — страница
 * приглашения — по той же причине, что и `/video`. Это ссылка, которой
 * делятся, и язык человека не должен зависеть от адреса, которым его
 * позвали: страница читает cookie переключателя сама
 * (`app/r/[code]/page.tsx`). Исключение записано как `r/` со слэшем
 * НАМЕРЕННО: голое `r` в этой альтернативе совпало бы с началом любого
 * пути на «r» — `/roadmap` перестал бы получать локаль.
 *
 * `qa/` — страница-полигон для разведчика чужих сайтов
 * (`app/qa/site-sandbox`, каталог
 * `backend/src/modules/client-site-tutorial/sandbox-catalog.ts`). Она
 * лежит вне `[locale]` сознательно: переводить полигон незачем, а пять
 * его адресов — это пять адресов страницы, которой в поиске быть не
 * должно (`robots.ts` держит `Disallow: /qa/`). Без этого исключения
 * запрос уезжал на `/ru/qa/site-sandbox` и получал 404 — страница была
 * недостижима с первого дня и до 29.09.2026, потому что открыть её
 * никто не пробовал. Со слэшем — по той же причине, что и `r/`.
 */
export const config = {
  matcher: [
    '/((?!_next|legal|feed|video|r/|qa/|icon|favicon.ico|robots.txt|sitemap.xml|.*\\..*).*)',
    '/stories-media/:path*',
    // ST2-U-04: OG-карточки Story‑Tales (`public/og/stories-<locale>.jpg`)
    // — на ЛЮБОМ хосте; иначе путь с точкой шёл мимо middleware и отдавал
    // промо «Скоро запуск» с 200.
    '/og/stories-:card',
    // ST2-U-05: поддомен Story‑Tales закрыт ЦЕЛИКОМ — и пути, исключённые
    // первой строкой (`/legal/*`, `/qa/*`, robots.txt, sitemap.xml,
    // статика, `_next`). Значение matcher должно быть литералом (Next
    // разбирает его при сборке), поэтому здесь шаблон «любой хост
    // story-tales.*», а точный хост (`NEXT_PUBLIC_STORIES_HOST`) сверяет
    // `isStoriesHost` ниже; прочие хосты под этот шаблон не попадают.
    { source: '/:path*', has: [{ type: 'host', value: 'story-tales\\..+' }] },
  ],
};

/**
 * Пути, которые идут в локализацию (`route`) — ровно первая строка
 * matcher. Путь, попавший в middleware только через строки Story‑Tales
 * (OG-карточки, хост story-tales.*), но не закрытый ими, дальше не
 * трогаем: иначе `/og/main-ru.jpg` уехал бы в `/ru/og/main-ru.jpg`.
 * Совпадение с matcher держит `scripts/stories-noindex.test.ts`.
 */
const LOCALIZED_PATH =
  /^\/(?!_next|legal|feed|video|r\/|qa\/|icon|favicon.ico|robots.txt|sitemap.xml|.*\..*).*$/;

/** OG-карточки Story‑Tales: `/og/stories-<что угодно>` на любом хосте. */
const STORIES_OG_PREFIX = '/og/stories-';

/**
 * Мини-лендинги на собственных поддоменах.
 *
 * Таблица, а не две одинаковые ветки: поддоменов стало два
 * (поздравления и обучалки по сайту заказчика), правило для них ОДНО, и
 * записанное дважды оно разъезжается на третьем. Третий — Story‑Tales
 * (16.10.2026) — встал строкой, как и задумано. `slug` — путь той же
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
  // Story‑Tales (решение 16.10, вечер): то же правило, что у соседей, но
  // страница не индексируется до режима `public` (Р-ST3-6), а в `closed`
  // не отдаётся вовсе — см. `withStoriesHeaders` и `middleware` ниже.
  { matches: isStoriesHost, siteUrl: STORIES_SITE_URL, slug: 'stories' },
];

/**
 * Story‑Tales: `X-Robots-Tag` и `Referrer-Policy` на КАЖДОМ ответе,
 * который рождает middleware для этой страницы — 308 с
 * `/<locale>/stories` на поддомен, 308 с `/<locale>/stories` поддомена в
 * `/<locale>`, rewrite корня поддомена, переход на главный домен.
 *
 * Тот же заголовок ставит и `next.config.js` (`headers()`), но правила
 * конфига не обязаны доезжать до ответов, созданных middleware: редирект
 * отсюда — отдельный ответ, и полагаться на то, что платформа допишет в
 * него заголовки конфига, значит проверять это на проде. Здесь он
 * ставится явно; на rewrite заголовки middleware переходят в итоговый
 * ответ страницы. Медиа (`/stories-media/*`), OG-карточки
 * (`/og/stories-*`) и весь хост story-tales.* matcher пропускает сюда
 * отдельными строками — в `closed` им middleware отвечает 404 (аудит 2,
 * ST2-U-04/05), в `pilot`/`public` пропускает дальше с этими же
 * заголовками; `next.config.js` остаётся вторым замком заголовков.
 *
 * `X-Robots-Tag` снимается только в `public` (Р-ST3-6): там страница
 * индексируется. `Referrer-Policy: no-referrer` остаётся во всех режимах
 * (Р-STL-7).
 */
function withStoriesHeaders(response: NextResponse, mode: StoriesLandingMode): NextResponse {
  if (!isStoriesIndexable(mode)) response.headers.set('X-Robots-Tag', STORIES_ROBOTS);
  response.headers.set('Referrer-Policy', STORIES_REFERRER_POLICY);
  return response;
}

/**
 * Всё, что относится к Story‑Tales: хост целиком, `/<locale>/stories`,
 * медиа и OG-карточки. В `closed` — 404; в остальных режимах — обычная
 * маршрутизация с заголовками Story‑Tales.
 */
function isStoriesRequest(host: string | null, pathname: string): boolean {
  return (
    isStoriesHost(host) ||
    isStoriesPath(pathname, locales) ||
    pathname.startsWith('/stories-media/') ||
    pathname.startsWith(STORIES_OG_PREFIX)
  );
}

export function middleware(request: NextRequest) {
  const mode = storiesLandingMode();
  const host = request.headers.get('host');
  const { pathname } = request.nextUrl;
  if (isStoriesRequest(host, pathname)) {
    // Closed development (STORY_TALES_LANDING=closed, the default): no
    // public Story landing, promo cards or media — on the Story host every
    // path, including /legal, /qa, robots, sitemap and static files
    // (ST2-U-04/05).
    if (!isStoriesOpen(mode)) {
      return withStoriesHeaders(new NextResponse('Not Found', { status: 404 }), mode);
    }
    // Pilot/public: OG-карточки, медиа, статика и `_next` поддомена — как
    // без middleware, но с заголовками Story‑Tales (noindex до `public`).
    if (!LOCALIZED_PATH.test(pathname)) {
      return withStoriesHeaders(NextResponse.next(), mode);
    }
  }
  // Пришёл только через строки matcher для Story‑Tales, но не относится к
  // ней — не локализуем (см. LOCALIZED_PATH).
  if (!LOCALIZED_PATH.test(pathname)) {
    return NextResponse.next();
  }
  const response = route(request);
  return isStoriesHost(host) || isStoriesPath(pathname, locales)
    ? withStoriesHeaders(response, mode)
    : response;
}

function route(request: NextRequest): NextResponse {
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

  // Saved explicit choice, then browser language; unknown languages fall back to English.
  const locale = visitorLocale(request.cookies.get(LOCALE_COOKIE)?.value, request.headers.get('accept-language'), request.headers.get('x-vercel-ip-country'));

  const url = request.nextUrl.clone();
  url.pathname = `/${locale}${pathname === '/' ? '' : pathname}`;
  const response = NextResponse.redirect(url);
  response.headers.set('Vary', 'Accept-Language, Cookie, X-Vercel-IP-Country');
  response.headers.set('Cache-Control', 'private, no-store');
  return response;
}
