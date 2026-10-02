/**
 * POST /assist/billing/webhook/wayforpay — serviceUrl мерчанта Помощника.
 * Подлинность — подпись HMAC-MD5 в теле (AssistPayments.handleWayForPay),
 * не initData. Ответ — подписанная квитанция `accept` ВСЕГДА (иначе
 * WayForPay повторяет доставку по расписанию); мерчант не настроен — 503
 * (провайдер повторит, когда env появится).
 *
 * Ответ — @Res() мимо общего конверта `{ success, data }`: провайдер
 * читает квитанцию на верхнем уровне JSON.
 *
 * Тело — не DTO: схему задаёт WayForPay. Некоторые интеграции WayForPay
 * присылают JSON строкой-ключом формы — разбираем и этот вид.
 */
import {
  Body,
  Controller,
  HttpCode,
  Post,
  Res,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Response } from 'express';
import { PublicRoute } from '../telegram-auth/allow-apps.decorator';
import {
  AssistPayments,
  type WayForPayAck,
  type WayForPayWebhookBody,
} from './payments.service';

export function wayforpayBody(body: unknown): WayForPayWebhookBody {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const o = body as Record<string, unknown>;
    const keys = Object.keys(o);
    if (keys.length === 1 && o[keys[0]] === '' && keys[0].startsWith('{')) {
      try {
        return JSON.parse(keys[0]) as WayForPayWebhookBody;
      } catch {
        return {} as WayForPayWebhookBody;
      }
    }
    return o as unknown as WayForPayWebhookBody;
  }
  if (typeof body === 'string') {
    try {
      return JSON.parse(body) as WayForPayWebhookBody;
    } catch {
      return {} as WayForPayWebhookBody;
    }
  }
  return {} as WayForPayWebhookBody;
}

@Controller('assist/billing/webhook')
@PublicRoute('вебхук WayForPay: подлинность — подпись мерчанта в теле')
export class AssistBillingWebhookController {
  constructor(private readonly payments: AssistPayments) {}

  @Post('wayforpay')
  @HttpCode(200)
  async wayforpay(@Body() body: unknown, @Res() res: Response): Promise<void> {
    const ack: WayForPayAck | null = await this.payments.handleWayForPay(
      wayforpayBody(body),
    );
    if (!ack) {
      throw new ServiceUnavailableException(
        'WayForPay помощника не настроен (ASSIST_WAYFORPAY_*)',
      );
    }
    // Мимо конверта ResponseInterceptor: WayForPay ждёт квитанцию
    // `{ orderReference, status: 'accept', time, signature }` на верхнем уровне.
    res.status(200).json(ack);
  }
}
