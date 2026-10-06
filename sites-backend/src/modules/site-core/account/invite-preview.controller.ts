/**
 * Превью приглашения (аудит Н-1):
 *
 *   GET /sites/account/invites/:token/preview   что будет, если принять
 *
 * Приглашение больше не принимается само при запуске: TMA/веб сначала
 * показывают экран «Вас приглашают в ЧУЖОЙ кабинет» — с этим ответом — и
 * принимают (`POST /sites/account/invites/accept`) только по кнопке.
 * Маршрут ничего не пишет и токен не тратит; нужна личность (initData
 * любого из двух ботов или веб-сессия), кабинет — нет: новичку его ещё не
 * создали, и создавать до решения нельзя.
 *
 * Лимит частоты — как у входа в веб-кабинет (LoginRateLimiter, окно в
 * памяти инстанса): по telegramId, перебор токена (24 случайных байта)
 * бессмыслен, лимит бережёт базу от залпа запросов.
 */

import {
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Param,
  Req,
} from '@nestjs/common';
import { AllowApps } from '../../telegram-auth/allow-apps.decorator';
import type { IdentifiedRequest } from '../../telegram-auth/identity';
import { LoginRateLimiter } from '../../telegram-auth/web/web-login';
import { AccountService } from './account.service';

/** Превью на человека: 30 в минуту — с запасом для повторов экрана. */
export const INVITE_PREVIEW_LIMIT = 30;
export const INVITE_PREVIEW_WINDOW_MS = 60_000;

@Controller('sites/account/invites')
@AllowApps('any')
export class InvitePreviewController {
  /** Один на инстанс — см. шапку LoginRateLimiter. */
  private readonly limiter = new LoginRateLimiter(
    INVITE_PREVIEW_LIMIT,
    INVITE_PREVIEW_WINDOW_MS,
  );

  constructor(private readonly accounts: AccountService) {}

  @Get(':token/preview')
  preview(@Req() req: IdentifiedRequest, @Param('token') token: string) {
    const waitMs = this.limiter.hit(req.identity.telegramId.toString());
    if (waitMs !== null) {
      throw new HttpException(
        {
          error: 'RATE_LIMIT_EXCEEDED',
          code: 'RATE_LIMIT_EXCEEDED',
          message: 'Слишком много запросов — подождите минуту',
          retryAfterMs: waitMs,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return this.accounts.previewInvite(req.identity, token);
  }
}
