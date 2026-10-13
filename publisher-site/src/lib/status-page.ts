import { PUBLISHER_BRAND } from '@/brand';
import { dict } from './dict';

/**
 * Простая HTML-страница статуса вне layout (410 снятого материала, 503 при
 * неизвестном статусе снятия): `noindex`, ссылки дальше. Цвета — те же
 * пары, что токены `globals.css` (контраст держит `scripts/tokens.test.ts`).
 */
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function statusPage(status: 410 | 503, title: string, text: string): Response {
  const e = dict.errors;
  const html = `<!DOCTYPE html><html lang="uk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${esc(`${title} — ${PUBLISHER_BRAND.name}`)}</title><style>body{font:1.0625rem/1.6 system-ui,sans-serif;margin:0;padding:2rem 1rem;color:#1a1a1a;background:#fff}main{max-width:40rem;margin:0 auto}a{color:#0b57d0}@media (prefers-color-scheme:dark){body{color:#ececec;background:#121212}a{color:#8ab4f8}}</style></head><body><main><h1>${esc(title)}</h1><p>${esc(text)}</p><p><a href="/materials">${esc(e.toMaterials)}</a> · <a href="/">${esc(e.toHome)}</a></p></main></body></html>`;
  const headers: Record<string, string> = {
    'content-type': 'text/html; charset=utf-8',
    'x-robots-tag': 'noindex, nofollow',
    'cache-control': status === 410 ? 'public, max-age=0, s-maxage=60' : 'no-store',
  };
  if (status === 503) headers['retry-after'] = '30';
  return new Response(html, { status, headers });
}
