/**
 * Fixture-токен — служебная аутентификация для автоматического
 * исполнителя сценариев обучающих видео (§3.3 ТЗ
 * doc/TMA-UI-SNAPSHOT-AND-TUTORIAL-VIDEO-SPEC.md, этап 97).
 *
 * ## Почему не ALLOW_DEV_AUTH
 *
 * §3.3 ТЗ прямо исключает dev-bypass для этой роли: та переменная
 * документирована как «не для прода» (doc/DEPLOYMENT.md), а исполнитель
 * сценариев обязан работать и на проде — иначе регрессия, случившаяся
 * только там, никогда не будет поймана. Нужен отдельный канал,
 * который прод не отключает.
 *
 * ## Почему копия cron-secret.ts, а не общая функция
 *
 * Тот же fail-closed + constant-time приём, что `cron-secret.ts` (этап
 * 54, Б-3.3): нет секрета — нет доступа, а не «секрет не задан, значит
 * открыто для локальной разработки». Не обобщено в одну функцию с
 * `assertCronSecret`, потому что семантика разная: там — бросить
 * исключение, если доступа нет (guard для маршрута крона); здесь —
 * вернуть личность или null, ничего не бросая (это ещё один
 * ОПЦИОНАЛЬНЫЙ источник identity для `TelegramIdentityMiddleware`,
 * которое в принципе никогда не отклоняет запрос за отсутствие
 * заголовка — см. доккомментарий этого middleware). Общая обёртка
 * ради 10 строк усложнила бы оба места больше, чем сэкономила.
 */

import { timingSafeEqual } from 'crypto';

export interface FixtureTokenEnv {
  FIXTURE_USER_TOKEN?: string;
  FIXTURE_TELEGRAM_ID?: string;
  [key: string]: string | undefined;
}

/**
 * Возвращает telegramId фикстурного пользователя, если предъявленный
 * заголовок совпадает с настроенным секретом — иначе null. Никогда не
 * бросает.
 *
 * Fail-closed без исключения для dev-стенда (в отличие от
 * `assertCronSecret`): у фикстурного входа нет причины работать без
 * секрета даже локально — сценарии и так можно проиграть руками через
 * обычный dev-bypass (`X-Dev-User-Id`), отдельный вход существует
 * ИМЕННО ради прод-режима.
 */
export function fixtureTelegramIdFromHeader(
  headerValue: string | undefined,
  env: FixtureTokenEnv = process.env,
): string | null {
  const secret = env.FIXTURE_USER_TOKEN?.trim();
  const telegramId = env.FIXTURE_TELEGRAM_ID?.trim();
  if (!secret || !telegramId) return null;
  if (!headerValue || !safeEqual(headerValue.trim(), secret)) return null;
  return telegramId;
}

/** Длины разные — сравнение всё равно делается, но над буферами равной
 * длины, чтобы ранний выход по длине не выдавал длину секрета (тот же
 * приём, что cron-secret.ts). */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufB, bufB);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}
