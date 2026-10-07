/**
 * Лимиты частоты маршрутов приглашения (аудит Н-1; TODO I-М «Сквозной
 * аудит 06.10.2026»): превью и принятие.
 *
 * Окно — в памяти инстанса (`LoginRateLimiter`, как у входа в
 * веб-кабинет): перебор токена (24 случайных байта) бессмыслен и так,
 * лимит бережёт базу от залпа запросов и не даёт одному человеку или
 * скрипту с одного адреса молотить `POST …/invites/accept`.
 *
 *  - на человека (`telegramId` проверенной личности) — 30 в минуту, как у
 *    превью: экран приглашения повторяет запрос считанные разы;
 *  - на адрес (`x-forwarded-for` за прокси Vercel) — шире: за одним NAT
 *    (мобильный оператор, офис) сидит много людей, и общее окно 30/мин
 *    отказывало бы им за соседа. Адресное окно ловит скрипт, который
 *    перебирает личности (ботов) с одного адреса.
 */

import { HttpException, HttpStatus } from '@nestjs/common';
import { LoginRateLimiter } from '../../telegram-auth/web/web-login';

export const INVITE_RATE_WINDOW_MS = 60_000;
/** Превью на человека. */
export const INVITE_PREVIEW_LIMIT = 30;
/** Принятие на человека — как у превью. */
export const INVITE_ACCEPT_LIMIT = 30;
/** Принятие на адрес: запас на NAT. */
export const INVITE_ACCEPT_IP_LIMIT = 120;

/** 429 в форме, которую ждёт site-tma-kit (как у превью и веб-входа). */
export function inviteRateLimited(waitMs: number): HttpException {
  return new HttpException(
    {
      error: 'RATE_LIMIT_EXCEEDED',
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Слишком много запросов — подождите минуту',
      retryAfterMs: waitMs,
    },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}

/**
 * Окна принятия приглашения. Один экземпляр на контроллер (= на инстанс).
 * Оба окна считают каждый запрос: человек за общим адресом расходует и
 * своё окно, и окно адреса.
 */
export class InviteAcceptLimiter {
  private readonly perPerson = new LoginRateLimiter(
    INVITE_ACCEPT_LIMIT,
    INVITE_RATE_WINDOW_MS,
  );
  private readonly perIp = new LoginRateLimiter(
    INVITE_ACCEPT_IP_LIMIT,
    INVITE_RATE_WINDOW_MS,
  );

  /** Бросает 429, если исчерпано любое из окон. */
  check(telegramId: bigint, ip: string, now = Date.now()): void {
    const person = this.perPerson.hit(telegramId.toString(), now);
    const addr = this.perIp.hit(ip, now);
    if (person !== null || addr !== null) {
      throw inviteRateLimited(Math.max(person ?? 0, addr ?? 0));
    }
  }
}
