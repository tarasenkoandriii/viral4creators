/**
 *   POST /api/me/environment   снять окружение текущего запуска
 *
 * Гвард обязателен: окружение ложится на строку пользователя, а у
 * анонимного пути такой строки нет. Тело не описано DTO с валидаторами
 * сознательно — вся проверка в `normalizeEnvironment()`, чистой функции
 * под тестом: полей полтора десятка, они необязательны каждое по
 * отдельности, и правило «поле есть не везде» декоратором выражается
 * хуже, чем кодом.
 */

import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import {
  IdentifiedRequest,
  TelegramIdentityGuard,
} from '../telegram-auth/telegram-identity.guard';
import { EnvironmentService } from './environment.service';

@Controller('me/environment')
@UseGuards(TelegramIdentityGuard)
export class EnvironmentController {
  constructor(private readonly service: EnvironmentService) {}

  @Post()
  async record(
    @Req() req: IdentifiedRequest,
    @Body() body: unknown,
  ): Promise<{ stored: boolean }> {
    return this.service.record(req.telegramUserId, body);
  }
}
