import { handlePilotRequest } from '../../../server/pilot-handler';
import { RateLimiter } from '../../../server/rate-limit';

/** Заявка в пилот → служебный Telegram-канал (см. `server/pilot-handler.ts`). */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const limiter = new RateLimiter();

export async function POST(req: Request): Promise<Response> {
  return handlePilotRequest(req, { limiter });
}
