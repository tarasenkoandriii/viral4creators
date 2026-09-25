/**
 * Управление ключами — из мини-аппа, обычным входом пользователя
 * (этап 144). Само внешнее API живёт в `V1Controller` рядом.
 *
 * Ключи заводит и отзывает человек в интерфейсе, а не ключ сам себя:
 * иначе утёкший ключ выписал бы себе второй, и отзыв первого ничего бы
 * не дал.
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  IdentifiedRequest,
  TelegramIdentityGuard,
} from '../telegram-auth/telegram-identity.guard';
import { RateLimit, RateLimitGuard } from '../../common/rate-limit';
import { ApiKeyService, ApiKeyView } from './api-key.service';

@Controller('api-keys')
@UseGuards(TelegramIdentityGuard)
export class ApiKeyController {
  constructor(private readonly service: ApiKeyService) {}

  @Get()
  list(
    @Req() req: IdentifiedRequest,
  ): Promise<{ keys: ApiKeyView[]; maxActive: number }> {
    return this.service.list(req.telegramUserId);
  }

  /**
   * Выдать ключ. Секрет в ответе — единственный раз, когда он вообще
   * существует за пределами памяти этого запроса.
   *
   * Под ограничителем частоты: выдача дешёвая для нас и очень удобная
   * для того, кто хочет набить базу мусором.
   */
  @Post()
  @UseGuards(RateLimitGuard)
  @RateLimit({ name: 'api-key-issue', limit: 10, windowSec: 3600 })
  issue(
    @Req() req: IdentifiedRequest,
    @Body() body: { name?: string },
  ): Promise<{ key: ApiKeyView; secret: string }> {
    return this.service.issue(req.telegramUserId, body?.name);
  }

  /**
   * Куда слать исход заявки (этап 146). Пустая строка — не слать.
   */
  @Patch(':id/webhook')
  setWebhook(
    @Req() req: IdentifiedRequest,
    @Param('id') id: string,
    @Body() body: { webhookUrl?: string },
  ): Promise<ApiKeyView> {
    return this.service.setWebhook(req.telegramUserId, id, body?.webhookUrl);
  }

  @Delete(':id')
  revoke(
    @Req() req: IdentifiedRequest,
    @Param('id') id: string,
  ): Promise<ApiKeyView> {
    return this.service.revoke(req.telegramUserId, id);
  }
}
