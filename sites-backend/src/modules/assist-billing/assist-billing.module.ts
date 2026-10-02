/**
 * Тарифы и оплата Помощника (Э4; ТЗ §3.10, §4.1, §7.1; модуль
 * `assist-billing-glue` §4.2): `ASSIST_PLANS`, счётчик единиц, кабинет
 * тарифа, Stars (бот Помощника) и WayForPay (мерчант Помощника), крон
 * продления/автодокупки/предупреждений.
 *
 * Публичная часть (public/ + чистые plans/units/subscription-state) —
 * её зовёт конвейер ответа под assist_public (правило графа public-zone-e4).
 */
import { Module } from '@nestjs/common';
import { SiteCoreModule } from '../site-core/site-core.module';
import { AssistBillingController } from './billing.controller';
import { BillingNotices } from './billing-notices';
import { AssistBillingTick } from './billing-tick.service';
import { AssistBillingTickController } from './billing-tick.controller';
import { AssistBillingWebhookController } from './billing-webhook.controller';
import { AssistBilling } from './billing.service';
import { AssistPayments } from './payments.service';
import { AssistPaymentProviders } from './providers';

@Module({
  imports: [SiteCoreModule],
  controllers: [
    AssistBillingController,
    AssistBillingWebhookController,
    AssistBillingTickController,
  ],
  providers: [
    AssistPaymentProviders,
    AssistPayments,
    AssistBilling,
    AssistBillingTick,
    BillingNotices,
  ],
  exports: [AssistPayments, AssistBilling, AssistPaymentProviders],
})
export class AssistBillingModule {}
