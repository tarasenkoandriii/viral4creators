/**
 * CreditLedgerModule — леджер кредитов на генерацию (этап 62, ТЗ §41.1).
 * `@Global`, тот же приём, что у `PlanModule`/`NotifyModule`: сервис
 * нужен трём независимым модулям (`generation` — списание/возврат,
 * `billing` — начисление после оплаты, `plan` — баланс в
 * `GET /api/me/plan`), и ни один из них не должен импортировать другой
 * ради этого — общий глобальный провайдер снимает саму необходимость.
 */

import { Global, Module } from '@nestjs/common';
import { CreditLedgerService } from './credit-ledger.service';

@Global()
@Module({
  providers: [CreditLedgerService],
  exports: [CreditLedgerService],
})
export class CreditLedgerModule {}
