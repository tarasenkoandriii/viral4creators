/**
 * Подтверждение владения способом «файл» (§3.2, необязательно): токен
 * site-core из `PUBLISHER_OWNERSHIP_TOKEN` первой строкой
 * (`site-core/ownership/ownership-checker.ts`). Не задан — 404. Для
 * ai-publisher.org рекомендован TXT.
 */
export const dynamic = 'force-dynamic';

export function GET() {
  const token = (process.env.PUBLISHER_OWNERSHIP_TOKEN ?? '').trim();
  const headers = {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'x-robots-tag': 'noindex, nofollow',
  };
  if (!/^[A-Za-z0-9_-]{8,200}$/.test(token)) return new Response('not found\n', { status: 404, headers });
  return new Response(`${token}\n`, { status: 200, headers });
}
