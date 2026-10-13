import { listWithdrawnSlugs } from '@/lib/api';

/**
 * Список снятых материалов для middleware (Z-2b). Middleware (edge) не
 * видит data cache Next и память route handlers — поэтому спрашивает этот
 * маршрут: он читает список через общий data cache с тегом `publisher`,
 * который сбрасывает `POST /api/revalidate` (его вызывает sites-backend при
 * снятии). Так сразу после ревалидации middleware видит снятие и отвечает
 * 410. Ответ не кэшируется (`no-store`), только служебный (noindex).
 * Формат — как у `GET /contents` (`{success, data:[{slug, withdrawn}]}`).
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  const headers = { 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow' };
  try {
    const slugs = await listWithdrawnSlugs();
    return Response.json({ success: true, data: slugs.map((slug) => ({ slug, withdrawn: true })) }, { headers });
  } catch {
    return Response.json({ success: false, error: { code: 'PUB_BUSY' } }, { status: 503, headers });
  }
}
