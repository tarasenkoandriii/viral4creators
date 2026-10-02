/**
 * Вебхуки двух ботов (ТЗ помощника §4.1, пути — как в QA-ТЗ):
 *   POST /assist/webhook/telegram — бот помощника, ASSIST_WEBHOOK_SECRET;
 *   POST /qa/webhook/telegram     — бот QA, QA_WEBHOOK_SECRET.
 *
 * Э0: только приём и `/start` в лог. Э3 (H): обновления бота Помощника
 * разбирает AssistBotUpdates (`/start` → assist_bot_users, кнопки
 * передачи, реплаи операторов) — ДО ответа 200 (на Vercel работа после
 * ответа не гарантирована). Сбой разбора — только в лог, ответ всё равно
 * 200: иначе Telegram повторял бы обновление, копя очередь недоставленных.
 * Бот QA — по-прежнему только приём.
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
  Optional,
  Post,
} from '@nestjs/common';
import type { TelegramApp } from '../../brand';
import { AssistBotUpdates } from '../assist-site-handoff/bot/assist-bot-updates.service';
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

  constructor(@Optional() private readonly updates?: AssistBotUpdates) {}

  @Post('assist/webhook/telegram')
  @HttpCode(200)
  async assist(
    @Headers(WEBHOOK_SECRET_HEADER.toLowerCase()) secret: string | undefined,
    @Body() update: unknown,
  ): Promise<{ ok: true }> {
    const res = this.handle('assist', secret, update);
    if (this.updates) {
      await this.updates.handle(update).catch((e: unknown) => {
        this.logger.warn(
          `[assist] обновление ${updateId(update)} не обработано: ${(e as Error | null)?.name ?? 'Error'}`,
        );
      });
    }
    return res;
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
