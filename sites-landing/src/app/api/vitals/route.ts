import { parseVital, VITAL_BODY_LIMIT } from '../../../lib/vitals';

/** Приёмник полевых CWV (см. `lib/vitals.ts`). Без cookie, без IP, без идентификатора. */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  const text = await req.text();
  if (text.length > VITAL_BODY_LIMIT) return new Response(null, { status: 413 });
  let sample = null;
  try {
    sample = parseVital(JSON.parse(text));
  } catch {
    sample = null;
  }
  if (!sample) return new Response(null, { status: 400 });
  console.log(JSON.stringify({ vital: sample.name, value: sample.value, rating: sample.rating, path: sample.path }));
  return new Response(null, { status: 204 });
}
