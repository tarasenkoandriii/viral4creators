/**
 *   GET  /me/marketing-consent          статус согласия на рассылку
 *   POST /me/marketing-consent          подписаться (или переподписаться)
 *   POST /me/marketing-consent/revoke   отписаться в один клик
 *
 * За TelegramIdentityGuard — рассылка идёт в личку по telegramId, значит
 * согласие имеет смысл только у идентифицированного пользователя;
 * анонимный путь получает понятную 401, фронт просто не показывает
 * переключатель.
 */

import { Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import {
  IdentifiedRequest,
  TelegramIdentityGuard,
} from '../telegram-auth/telegram-identity.guard';
import {
  MarketingConsentService,
  MarketingConsentStatus,
} from './marketing-consent.service';

@Controller('me/marketing-consent')
@UseGuards(TelegramIdentityGuard)
export class MarketingConsentController {
  constructor(private readonly service: MarketingConsentService) {}

  @Get()
  status(@Req() req: IdentifiedRequest): Promise<MarketingConsentStatus> {
    return this.service.status(req.telegramUserId);
  }

  @Post()
  accept(@Req() req: IdentifiedRequest): Promise<MarketingConsentStatus> {
    return this.service.accept(req.telegramUserId);
  }

  @Post('revoke')
  revoke(@Req() req: IdentifiedRequest): Promise<MarketingConsentStatus> {
    return this.service.revoke(req.telegramUserId);
  }
}
