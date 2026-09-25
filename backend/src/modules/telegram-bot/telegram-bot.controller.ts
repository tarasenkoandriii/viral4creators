/**
 * Вебхук бота (этап 155).
 *
 * Путь `POST /api/billing/webhook/telegram` сохранён ДОСЛОВНО, хотя
 * контроллер больше не биллинговый: адрес задан в Telegram через
 * `setWebhook`, и его смена требует ручного шага и оставляет окно, в
 * котором апдейты теряются. Имя пути стало историческим — цена, которой
 * незачем платить за красоту URL.
 */

import { Body, Controller, Headers, HttpCode, Post } from '@nestjs/common';
import { assertTelegramWebhookSecret } from '../billing/telegram-webhook-secret';
import { TelegramBotService } from './telegram-bot.service';
import { TelegramUpdate } from './telegram-update';

@Controller('billing')
export class TelegramBotController {
  constructor(private readonly bot: TelegramBotService) {}

  @Post('webhook/telegram')
  @HttpCode(200)
  async webhook(
    @Headers('x-telegram-bot-api-secret-token') secret: string | undefined,
    @Body() update: TelegramUpdate,
  ): Promise<{ ok: true }> {
    assertTelegramWebhookSecret(secret);
    await this.bot.dispatch(update);
    return { ok: true };
  }
}
