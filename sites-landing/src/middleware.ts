import { NextResponse, type NextRequest } from 'next/server';
import { PRODUCT_LINKS } from './brand';
import { siteUrl } from './lib/site-url';
import {
  isLocale,
  LOCALE_COOKIE,
  LOCALE_SWITCH_PARAM,
  visitorLocale,
  type Locale,
} from './lib/i18n';

/**
 * Локали в URL (ТЗ §8.1, §11), порт приёма `landing/src/middleware.ts`:
 *
 *  1. `/<loc>/…?hl=<loc>` — ссылка переключателя языка. Пишем cookie
 *     явного выбора (§10.1: выбор языка — необходимое хранение по явному
 *     действию) и 307 на тот же адрес без `hl` — дублей адресов нет.
 *  2. `/<loc>/…` — как есть.
 *  3. Всё остальное (`/`, `/assistant`) — 307 на `/<loc>/…`: локаль из
 *     cookie выбора, затем из страны Vercel и `Accept-Language`, иначе `en` (= x-default).
 *     307, а не 308: ответ зависит от человека, кэшировать навсегда нельзя.
 *
 * Вне локалей: `/_next`, `/api`, `/legal` (одна редакция, §3.15), файлы
 * с точкой (`robots.txt`, `sitemap.xml`, `/og/*.jpg`, `icon.svg`).
 */
export const config = {
  matcher: ['/((?!_next/|api/|legal/|.*\\..*).*)'],
};

const YEAR = 60 * 60 * 24 * 365;

export function localeOfPath(pathname: string): Locale | null {
  const seg = pathname.split('/')[1];
  return isLocale(seg) ? seg : null;
}

export function middleware(request: NextRequest) {
  const { pathname, searchParams } = request.nextUrl;
  const current = localeOfPath(pathname);
  // Campaign hostname has one canonical destination, without a second copy
  // of the assistant homepage or a language fixed in shared links.
  if (request.nextUrl.hostname.toLowerCase() === PRODUCT_LINKS.voiceHost) {
    const locale = current ?? visitorLocale(request.cookies.get(LOCALE_COOKIE)?.value,
      request.headers.get('accept-language'), request.headers.get('x-vercel-ip-country'));
    const target = new URL(`/${locale}/hands-free`, siteUrl());
    target.search = request.nextUrl.search;
    const res = NextResponse.redirect(target, 307);
    res.headers.set('Vary', 'Accept-Language, Cookie, X-Vercel-IP-Country');
    res.headers.set('Cache-Control', 'private, no-store');
    return res;
  }

  if (current) {
    const chosen = searchParams.get(LOCALE_SWITCH_PARAM);
    if (chosen !== null) {
      const url = request.nextUrl.clone();
      url.searchParams.delete(LOCALE_SWITCH_PARAM);
      const res = NextResponse.redirect(url, 307);
      if (isLocale(chosen) && chosen === current) {
        res.cookies.set(LOCALE_COOKIE, chosen, { path: '/', maxAge: YEAR, sameSite: 'lax' });
      }
      return res;
    }
    return NextResponse.next();
  }

  const cookie = request.cookies.get(LOCALE_COOKIE)?.value;
  const locale: Locale = visitorLocale(cookie, request.headers.get('accept-language'), request.headers.get('x-vercel-ip-country'));
  const url = request.nextUrl.clone();
  url.pathname = `/${locale}${pathname === '/' ? '' : pathname}`;
  const res = NextResponse.redirect(url, 307);
  res.headers.set('Vary', 'Accept-Language, Cookie, X-Vercel-IP-Country');
  res.headers.set('Cache-Control', 'private, no-store');
  return res;
}
