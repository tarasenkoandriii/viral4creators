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
 * Э4: обновления оплаты Stars бота Помощника (`pre_checkout_query`,
 * `message.successful_payment`) разбирает AssistPayments — до передачи
 * человеку; владелец добавляет `pre_checkout_query` в allowed_updates.
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
  InternalServerErrorException,
  Logger,
  Optional,
  Post,
} from '@nestjs/common';
import type { TelegramApp } from '../../brand';
import { AssistPayments } from '../assist-billing/payments.service';
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

  constructor(
    @Optional() private readonly updates?: AssistBotUpdates,
    @Optional() private readonly payments?: AssistPayments,
  ) {}

  @Post('assist/webhook/telegram')
  @HttpCode(200)
  async assist(
    @Headers(WEBHOOK_SECRET_HEADER.toLowerCase()) secret: string | undefined,
    @Body() update: unknown,
  ): Promise<{ ok: true }> {
    const res = this.handle('assist', secret, update);
    // Э4: оплата Stars (pre_checkout_query — ответ ≤ 10 с; successful_payment
    // — применить тариф). В отличие от прочих обновлений сбой здесь — НЕ 200:
    // деньги уже списаны, и Telegram должен повторить доставку (применение
    // идемпотентно: одна строка на telegram_payment_charge_id).
    if (this.payments) {
      let paid: boolean;
      try {
        paid = await this.payments.handleTelegramUpdate(update);
      } catch (e) {
        this.logger.error(
          `[assist] оплата ${updateId(update)} не обработана: ${(e as Error | null)?.name ?? 'Error'}`,
        );
        throw new InternalServerErrorException('payment update failed');
      }
      if (paid) return res;
    }
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
