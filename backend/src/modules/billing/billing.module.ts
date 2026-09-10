/**
 * BillingModule — оплата Telegram Stars и WayForPay (этап 62, ТЗ §41).
 * `PrismaModule`/`PlanModule`/`CreditLedgerModule`/`NotifyModule`
 * глобальные (@Global()), поэтому большую часть зависимостей объявлять
 * в `imports` не нужно — тот же паттерн, что у
 * `publishing-channel.module.ts`.
 *
 * `TelegramStarsService` с этапа 64 живёт в собственном @Global()
 * `TelegramStarsModule` (Г-2.2 аудита round4) — он нужен не только этому
 * модулю, но и `PlanService`/`AdminUsersService` для немедленной отмены
 * подписки в Telegram; здесь он больше не объявляется как provider, чтобы
 * не завести двух конкурирующих экземпляров.
 *
 * `LegalModule` — НЕ `@Global()` (в отличие от перечисленных выше), поэтому
 * его нужно явно импортировать: `BillingService` теперь проверяет акцепт
 * оферты перед стартом чекаута (Г-6.4 аудита round4, см. комментарий в
 * `billing.service.ts`).
 */

import { Module } from '@nestjs/common';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { WayForPayService } from './wayforpay.service';
import { LegalModule } from '../legal/legal.module';

@Module({
  imports: [LegalModule],
  controllers: [BillingController],
  providers: [BillingService, WayForPayService],
  exports: [BillingService, WayForPayService],
})
export class BillingModule {}
