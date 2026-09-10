/**
 * BillingRenewalModule — крон-воркер продления подписок (этап 62, ТЗ
 * §41.4). Импортирует `BillingModule` явно (не глобальный) — единственный
 * способ достать `WayForPayService`, не дублируя провайдер.
 */

import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module';
import { BillingRenewalWorkerService } from './billing-renewal-worker.service';
import { WayForPayRenewalService } from './wayforpay-renewal.service';
import { StarsSubscriptionReconcileService } from './stars-subscription-reconcile.service';

@Module({
  imports: [BillingModule],
  providers: [
    BillingRenewalWorkerService,
    WayForPayRenewalService,
    StarsSubscriptionReconcileService,
  ],
  exports: [BillingRenewalWorkerService],
})
export class BillingRenewalModule {}
