/**
 * Проверка секрета крона sites-backend — правило то же, что у backend
 * (backend/src/modules/cron/cron-secret.ts, там история Б-3.3):
 *
 *  - нет `CRON_SECRET` — маршрут ЗАКРЫТ (503), кроме dev-стенда
 *    (`ALLOW_DEV_AUTH=true` и `NODE_ENV !== 'production'`, shared/dev-login);
 *  - Vercel Cron шлёт `Authorization: Bearer <CRON_SECRET>`; сравнение
 *    constant-time;
 *  - маршруты GET — ограничение Vercel Cron; от префетча защищает сам
 *    секрет.
 *
 * Своя копия, а не sync-sites-shared: исходник backend импортирует
 * dev-login по своему пути (решение координатора Э0, п.3 — копируются
 * только чистые модули).
 */

import {
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import { DevAuthEnv, isDevAuthAllowed } from '../shared/dev-login';

export interface CronSecretEnv extends DevAuthEnv {
  CRON_SECRET?: string;
}

export function assertCronSecret(
  authHeader: string | undefined,
  env: CronSecretEnv = process.env,
): void {
  const secret = env.CRON_SECRET?.trim();
  if (!secret) {
    if (isDevAuthAllowed(env)) return;
    throw new ServiceUnavailableException(
      'CRON_SECRET не задан — крон-маршруты закрыты, пока переменная не появится',
    );
  }
  const presented = bearerToken(authHeader);
  if (!presented || !safeEqual(presented, secret)) {
    throw new UnauthorizedException('Неверный или отсутствующий секрет крона');
  }
}

function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || undefined;
}

/** Разные длины — сравнение всё равно делается, чтобы не выдать длину. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufB, bufB);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}
