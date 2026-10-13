import { NextResponse, type NextRequest } from 'next/server';
import { dict } from '@/lib/dict';
import { statusPage } from '@/lib/status-page';
import { slugState } from '@/lib/withdrawn';

/**
 * Снятый материал → 410 (`/gone/[slug]`); статус снятия неизвестен (API
 * недоступен) → 503 без текста (fail-closed, аудит S2-2); остальное — без
 * изменений.
 */
export async function middleware(req: NextRequest) {
  const m = /^\/materials\/([a-z0-9-]{3,80})\/?$/.exec(req.nextUrl.pathname);
  const api = process.env.PUBLISHER_API_ORIGIN;
  const key = process.env.PUBLISHER_PUBLIC_KEY;
  if (!m || !api || !key) return NextResponse.next();
  const state = await slugState({ site: req.nextUrl.origin, api }, key, m[1]);
  if (state === 'pass') return NextResponse.next();
  if (state === 'unknown') return statusPage(503, dict.meta.unavailableTitle, dict.errors.unavailable);
  const url = req.nextUrl.clone();
  url.pathname = `/gone/${m[1]}`;
  url.search = '';
  return NextResponse.rewrite(url);
}

export const config = { matcher: ['/materials/:slug'] };
