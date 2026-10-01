/**
 * Вебхуки двух ботов (ТЗ помощника §4.1, пути — как в QA-ТЗ):
 *   POST /assist/webhook/telegram — бот помощника, ASSIST_WEBHOOK_SECRET;
 *   POST /qa/webhook/telegram     — бот QA, QA_WEBHOOK_SECRET.
 *
 * Э0: только приём и `/start` в лог — ответов боту нет (отправка
 * сообщений, кнопка Mini App, оператор передачи — следующие этапы).
 * Любое другое обновление — тоже 200: иначе Telegram повторял бы его,
 * копя очередь недоставленных.
 *
 * Тело — не DTO: схему Update задаёт Telegram, а глобальный
 * `forbidNonWhitelisted` отверг бы любое новое поле. Разбираем руками
 * только то, что нужно.
 */

import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Logger,
  Post,
} from '@nestjs/common';
import type { TelegramApp } from '../../brand';
import { PublicRoute } from '../telegram-auth/allow-apps.decorator';
import {
  WEBHOOK_SECRET_HEADER,
  assertBotWebhookSecret,
} from './webhook-secret';

/** Команда `/start` (в том числе `/start payload` и `/start@имя_бота`). */
export function isStartCommand(update: unknown): boolean {
  if (typeof update !== 'object' || update === null) return false;
  const message = (update as { message?: unknown }).message;
  if (typeof message !== 'object' || message === null) return false;
  const text = (message as { text?: unknown }).text;
  return typeof text === 'string' && /^\/start(?:@\w+)?(?:\s|$)/.test(text);
}

function updateId(update: unknown): string {
  const id = (update as { update_id?: unknown } | null)?.update_id;
  return typeof id === 'number' ? String(id) : '—';
}

@Controller()
@PublicRoute('вебхук Telegram: подлинность — секрет в заголовке, не initData')
export class TelegramWebhookController {
  private readonly logger = new Logger(TelegramWebhookController.name);

  @Post('assist/webhook/telegram')
  @HttpCode(200)
  assist(
    @Headers(WEBHOOK_SECRET_HEADER.toLowerCase()) secret: string | undefined,
    @Body() update: unknown,
  ): { ok: true } {
    return this.handle('assist', secret, update);
  }

  @Post('qa/webhook/telegram')
  @HttpCode(200)
  qa(
    @Headers(WEBHOOK_SECRET_HEADER.toLowerCase()) secret: string | undefined,
    @Body() update: unknown,
  ): { ok: true } {
    return this.handle('qa', secret, update);
  }

  private handle(
    app: TelegramApp,
    secret: string | undefined,
    update: unknown,
  ): { ok: true } {
    assertBotWebhookSecret(app, secret);
    // В лог — только номер обновления: ни текста, ни chat id, ни секрета.
    if (isStartCommand(update)) {
      this.logger.log(`[${app}] /start, update ${updateId(update)}`);
    }
    return { ok: true };
  }
}
