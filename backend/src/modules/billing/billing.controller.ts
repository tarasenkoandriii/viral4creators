/**
 *   GET  /billing/prices                   ПУБЛИЧНЫЙ — цены подписок и пакетов кредитов
 *   POST /billing/checkout/subscription    identity — {plan, method} → CheckoutResult
 *   POST /billing/checkout/credit-pack     identity — {packId, method} → CheckoutResult
 *   POST /billing/webhook/telegram         ПУБЛИЧНЫЙ, секрет в заголовке (Telegram)
 *   POST /billing/webhook/wayforpay        ПУБЛИЧНЫЙ, подпись в теле (WayForPay)
 *
 * Вебхуки — не под `TelegramIdentityGuard` (их дёргает сам провайдер, без
 * наших заголовков идентичности), но не голые: каждый защищён СВОИМ
 * механизмом доказательства подлинности отправителя (ТЗ §41.3).
 */

import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  IdentifiedRequest,
  TelegramIdentityGuard,
} from '../telegram-auth/telegram-identity.guard';
import { BillingService, WayForPayWebhookBody } from './billing.service';
import {
  StartCreditPackCheckoutDto,
  StartSubscriptionCheckoutDto,
} from './dto/start-checkout.dto';
import { CheckoutResult } from './billing.types';
import { localeFromRequest } from '../../common/locale';
import { wayforpayBody } from '../../common/wayforpay-body';

@Controller('billing')
export class BillingController {
  constructor(private readonly service: BillingService) {}

  @Get('prices')
  getPrices(@Req() req: IdentifiedRequest) {
    return this.service.getPrices(localeFromRequest(req));
  }

  @Post('checkout/subscription')
  @UseGuards(TelegramIdentityGuard)
  startSubscription(
    @Req() req: IdentifiedRequest,
    @Body() dto: StartSubscriptionCheckoutDto,
  ): Promise<CheckoutResult> {
    return this.service.startSubscriptionCheckout(
      req.telegramUserId,
      dto.plan,
      dto.method,
    );
  }

  @Post('checkout/credit-pack')
  @UseGuards(TelegramIdentityGuard)
  startCreditPack(
    @Req() req: IdentifiedRequest,
    @Body() dto: StartCreditPackCheckoutDto,
  ): Promise<CheckoutResult> {
    return this.service.startCreditPackCheckout(
      req.telegramUserId,
      dto.packId,
      dto.method,
      localeFromRequest(req),
    );
  }

  // Вебхук Telegram переехал в `modules/telegram-bot` (этап 155): он
  // один на весь бот, и с появлением команд его стал разбирать
  // диспетчер. Путь при этом не изменился — `setWebhook` менять не
  // пришлось. Сам `handleTelegramUpdate` остался в этом сервисе и
  // вызывается диспетчером без единой правки.

  /**
   * Аудит Э4 (2026-10-02): квитанция `{orderReference, status:'accept',
   * time, signature}` должна лежать на ВЕРХНЕМ уровне JSON — так её
   * читает WayForPay. Возврат значения из хендлера заворачивался
   * глобальным `ResponseInterceptor` в `{success, data, meta}`, провайдер
   * квитанции не видел и повторял доставку. `@Res()` без `passthrough`
   * выводит ответ из-под интерцептора (тот же приём, что у
   * `sites-backend` assist-billing/billing-webhook.controller.ts).
   */
  // Заход 12 (аудит P2-3): тело — не DTO, схему задаёт WayForPay. Без
  // тела, `text/plain` или форма с JSON строкой-ключом раньше доходили
  // как `{}`/форма → TypeError в сверке подписи → 500, провайдер повторял
  // доставку, оплата не зачитывалась. `wayforpayBody` (общий с
  // sites-backend) приводит тело к одному виду, сервис отвечает
  // квитанцией или 400 (нет orderReference).
  @Post('webhook/wayforpay')
  @HttpCode(200)
  async wayforpayWebhook(
    @Body() body: unknown,
    @Res() res: Response,
  ): Promise<void> {
    const ack = await this.service.handleWayForPayWebhook(
      wayforpayBody<WayForPayWebhookBody>(body),
    );
    res.status(200).json(ack);
  }
}
