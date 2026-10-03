/**
 * Хеш IP для журнала карты интерфейса (Э-С Ш4, аудит 03.10.2026): промахи
 * «не найден» и голоса «найден» считаются от РАЗНЫХ IP за окно
 * устаревания (`UI_MAP_STALE.windowMs`, 7 дней). Суточная соль visitor-
 * token (`ipHash`, §6.4) это ослабляла: один адрес на следующий день — уже
 * «другой IP». Здесь соль — номер окна (неделя, ротация на границе окна) +
 * секрет виджета + соль сайта: внутри окна один адрес — один хеш, между
 * окнами и сайтами — не сопоставим. Сырой IP не хранится нигде.
 */
import { createHash } from 'crypto';
import { widgetIpSecret } from '../../config/widget-env';
import type { AssistPublicDb } from '../../prisma/assist-public-db.service';
import { ipLimitKey } from '../assist-sandbox/sandbox-limits';
import { UI_MAP_STALE } from '../site-core/ui-map/ui-map-model';
import { clientIp } from '../telegram-auth/web/web-request';

/** Номер окна: `floor(now / windowMs)` (UTC, от эпохи). */
export function voteWindow(
  now: Date,
  windowMs = UI_MAP_STALE.windowMs,
): number {
  return Math.floor(now.getTime() / windowMs);
}

/** `sha256(ip:окно:секрет:соль сайта)` — чистая функция (тесты). */
export function windowIpHash(
  ip: string,
  secret: string,
  siteSalt: string | null,
  now: Date,
  windowMs = UI_MAP_STALE.windowMs,
): string {
  return createHash('sha256')
    .update(
      `ui-map-vote:${ipLimitKey(ip)}:w${voteWindow(now, windowMs)}:${secret}:${siteSalt ?? ''}`,
    )
    .digest('hex');
}

/**
 * Хеш IP запроса для журнала карты сайта; адреса нет (тест, прокси без
 * заголовка) или нет секрета — суточный `fallback` из visitor-token.
 */
export async function uiVoteIpHash(
  db: Pick<AssistPublicDb, 'assistSite'>,
  p: {
    siteId: string;
    req: Parameters<typeof clientIp>[0];
    fallback: string;
    now: Date;
    env?: NodeJS.ProcessEnv;
  },
): Promise<string> {
  const ip = clientIp(p.req);
  const secret = widgetIpSecret(p.env);
  if (!ip || ip === 'unknown' || !secret) return p.fallback;
  const site = await db.assistSite.findUnique({
    where: { siteId: p.siteId },
    select: { ipSalt: true },
  });
  return windowIpHash(ip, secret, site?.ipSalt ?? null, p.now);
}
