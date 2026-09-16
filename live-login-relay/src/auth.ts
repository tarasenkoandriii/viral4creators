/**
 * Проверка X-Relay-Secret — doc/LIVE-LOGIN-RELAY-SPEC.md §10.1.
 *
 * Тот же fail-closed + `timingSafeEqual` приём, что
 * `backend/src/modules/cron/cron-secret.ts`, СОЗНАТЕЛЬНО БЕЗ
 * dev-исключения того файла: единственный легитимный вызывающий здесь —
 * backend, который всегда знает секрет из своих переменных окружения, а
 * локальная разработка визарда не требует поднимать реле вообще (кнопка
 * live-входа просто прячется на фронтенде, если LIVE_LOGIN_RELAY_URL не
 * задан — doc/CLIENT-SITE-TUTORIAL-SPEC.md §7.4.9). Секрет обязателен
 * всегда, включая локальный запуск самого реле.
 */

import { timingSafeEqual } from 'node:crypto';

export class UnauthorizedError extends Error {}

export function assertRelaySecret(
  headerValue: string | undefined,
  expectedSecret: string,
): void {
  if (!headerValue || !safeEqual(headerValue.trim(), expectedSecret)) {
    throw new UnauthorizedError('неверный или отсутствующий X-Relay-Secret');
  }
}

/** Длины разные — сравнение всё равно делается, но над буферами равной
 * длины, чтобы ранний выход по длине не выдавал длину секрета (тот же
 * приём, что `cron-secret.ts`/`fixture-token.ts` в основном backend'е). */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufB, bufB);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}
