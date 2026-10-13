import { timingSafeEqual } from 'node:crypto';
import { revalidatePath, revalidateTag } from 'next/cache';
import { CACHE_TAG } from '@/lib/api';

/**
 * `POST /api/revalidate` (§13.3, §13.7): мгновенное обновление после
 * публикации/снятия материала и снятия индексации. Только с секретом
 * `PUBLISHER_REVALIDATE_SECRET` (`Authorization: Bearer …`); секрет не
 * задан — маршрута как бы нет (404). Сбрасывает данные API (тег) и все
 * страницы; список снятых slug у middleware живёт своим кэшем ≤ 60 с.
 */
export const dynamic = 'force-dynamic';

function authorized(header: string | null, secret: string): boolean {
  const m = /^Bearer (.+)$/.exec(header ?? '');
  if (!m) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: Request) {
  const secret = process.env.PUBLISHER_REVALIDATE_SECRET ?? '';
  const headers = { 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow' };
  if (secret.length < 16) return Response.json({ ok: false }, { status: 404, headers });
  if (!authorized(req.headers.get('authorization'), secret))
    return Response.json({ ok: false }, { status: 401, headers });
  revalidateTag(CACHE_TAG);
  revalidatePath('/', 'layout');
  return Response.json({ ok: true, revalidated: true }, { headers });
}
