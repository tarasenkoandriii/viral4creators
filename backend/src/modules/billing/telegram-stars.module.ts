/**
 * TelegramStarsModule — выделен из `BillingModule` отдельным `@Global()`
 * модулем (аудит round4, Г-2.2, этап 64), потому что `TelegramStarsService`
 * нужен не только оплате: `PlanService.setPlan()` и
 * `AdminUsersService.cancelSubscription()` должны сразу же (не только на
 * следующий крон продления) сообщить Telegram об отмене подписки Stars
 * через `editUserStarSubscription` — иначе Telegram продолжает списывать
 * Stars каждые 30 дней после локальной отмены (Г-2.2). Тот же приём, что
 * `PlanModule`/`CreditLedgerModule`/`NotifyModule`: сервис нужен
 * нескольким независимым модулям, и ни один из них не должен
 * импортировать другой ради одного клиента Bot API.
 */

import { Global, Module } from '@nestjs/common';
import { TelegramStarsService } from './telegram-stars.service';

@Global()
@Module({
  providers: [TelegramStarsService],
  exports: [TelegramStarsService],
})
export class TelegramStarsModule {}
