import { handleOptOut } from '../../../server/opt-out';
import { RateLimiter } from '../../../server/rate-limit';

/** «Уберите мой сайт» → служебный Telegram-канал (см. `server/opt-out.ts`). */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const limiter = new RateLimiter({ perKey: 3, windowMs: 10 * 60 * 1000, globalPerHour: 30 });

export async function POST(req: Request): Promise<Response> {
  return handleOptOut(req, { limiter });
}
