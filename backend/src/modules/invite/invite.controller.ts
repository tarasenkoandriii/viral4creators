/**
 * Маршруты кабинета «Пригласить» — этап 133.
 *
 * `/referrals`, а не `/invite`: этап 134 добавит сюда код приглашения,
 * список приведённых и приём переходов, и звать всё это «referrals» на
 * сервере честнее, чем растягивать «invite» на то, чего экран не
 * показывает.
 */

import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { RateLimit, RateLimitGuard } from '../../common/rate-limit';
import { TelegramIdentifiedRequest } from '../telegram-auth/telegram-identity.middleware';
import { TelegramIdentityGuard } from '../telegram-auth/telegram-identity.guard';
import { InviteService, InviteState } from './invite.service';
import { ReferralService } from './referral.service';
import { ClaimDto } from './dto/referral.dto';

@Controller('referrals')
@UseGuards(TelegramIdentityGuard)
export class InviteController {
  constructor(
    private readonly invite: InviteService,
    private readonly referrals: ReferralService,
  ) {}

  /** Состояние сделки для экрана. */
  @Get('me')
  async me(@Req() req: TelegramIdentifiedRequest): Promise<InviteState> {
    return this.invite.stateOf(this.userOf(req));
  }

  /**
   * «Я подписался» — проверка подписки на Telegram-канал.
   *
   * Лимит жёсткий и намеренно: за кнопкой стоит запрос к чужому API, а
   * нажимать её человек будет ровно один раз в жизни. Двадцать нажатий
   * в минуту — это уже не человек.
   */
  @Post('telegram/check')
  @HttpCode(200)
  @UseGuards(RateLimitGuard)
  @RateLimit({ name: 'unlock-telegram-check', limit: 10, windowSec: 60 })
  async checkTelegram(
    @Req() req: TelegramIdentifiedRequest,
  ): Promise<InviteState> {
    return this.invite.confirmTelegram(this.userOf(req));
  }

  /**
   * Привязать вошедшего к пригласившему (§5.2, этап 134).
   *
   * Зовётся клиентом СРАЗУ после первой идентификации, с кодом, который
   * он донёс из ссылки. Ответ намеренно без подробностей: «не
   * применился» может означать и чужой код, и то, что человек уже
   * привязан, и самоприглашение, — и ни об одном из этих случаев ему
   * говорить нечего, он не делал ничего плохого.
   */
  @Post('claim')
  @HttpCode(200)
  @UseGuards(RateLimitGuard)
  @RateLimit({ name: 'referral-claim', limit: 10, windowSec: 60 })
  async claim(
    @Req() req: TelegramIdentifiedRequest,
    @Body() dto: ClaimDto,
  ): Promise<{ claimed: boolean }> {
    const claimed = await this.referrals.claim(this.userOf(req), dto.code);
    return { claimed };
  }

  /**
   * Гвард уже не пустил бы анонимного, но полагаться на это в коде,
   * который выдаёт генерации, не стоит: гвард могут снять правкой в
   * другом файле, а тут начисляются деньги.
   */
  private userOf(req: TelegramIdentifiedRequest): string {
    const userId = req.telegramUserId;
    if (!userId) throw new UnauthorizedException('Нужен вход через Telegram');
    return userId;
  }
}
