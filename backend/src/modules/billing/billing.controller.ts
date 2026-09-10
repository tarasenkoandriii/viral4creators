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
  Headers,
  HttpCode,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  IdentifiedRequest,
  TelegramIdentityGuard,
} from '../telegram-auth/telegram-identity.guard';
import {
  BillingService,
  TelegramUpdateBody,
  WayForPayWebhookBody,
} from './billing.service';
import {
  StartCreditPackCheckoutDto,
  StartSubscriptionCheckoutDto,
} from './dto/start-checkout.dto';
import { CheckoutResult } from './billing.types';
import { assertTelegramWebhookSecret } from './telegram-webhook-secret';
import { localeFromRequest } from '../../common/locale';

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

  @Post('webhook/telegram')
  @HttpCode(200)
  async telegramWebhook(
    @Headers('x-telegram-bot-api-secret-token') secret: string | undefined,
    @Body() update: TelegramUpdateBody,
  ): Promise<{ ok: true }> {
    assertTelegramWebhookSecret(secret);
    await this.service.handleTelegramUpdate(update);
    return { ok: true };
  }

  @Post('webhook/wayforpay')
  @HttpCode(200)
  wayforpayWebhook(@Body() body: WayForPayWebhookBody) {
    return this.service.handleWayForPayWebhook(body);
  }
}
