import { NextRequest, NextResponse } from 'next/server';
import { visitorLocale, locales, LOCALE_COOKIE } from './lib/i18n';

/**
 * Локаль-редирект — тот же паттерн, что у landing/src/middleware.ts.
 *
 * Исключения из матчера (см. lib/i18n.ts для причин каждого):
 *  - `embed` — встраиваемый виджет портфолио (§20 №5), без локали;
 *  - `feed` (ловит `feed.xml`, `feed.json`) — единая лента на все языки;
 *  - обычные технические пути (`_next`, favicon и т.д.).
 */
export const config = {
  matcher: ['/((?!_next|embed|feed|icon|favicon.ico|robots.txt|sitemap.xml|.*\\..*).*)'],
};

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const pathnameHasLocale = locales.some(
    (locale) => pathname.startsWith(`/${locale}/`) || pathname === `/${locale}`,
  );
  if (pathnameHasLocale) return NextResponse.next();

  const locale = visitorLocale(request.cookies.get(LOCALE_COOKIE)?.value, request.headers.get('accept-language'), request.headers.get('x-vercel-ip-country'));

  const url = request.nextUrl.clone();
  url.pathname = `/${locale}${pathname === '/' ? '' : pathname}`;
  const response = NextResponse.redirect(url);
  response.headers.set('Vary', 'Accept-Language, Cookie, X-Vercel-IP-Country');
  response.headers.set('Cache-Control', 'private, no-store');
  return response;
}
