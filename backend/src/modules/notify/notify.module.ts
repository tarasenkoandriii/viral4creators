/**
 * NotifyModule — служебные каналы Telegram (ТЗ §28, этап 45).
 *
 * `@Global`, потому что тревоги шлют из разных мест (фильтр исключений,
 * генерация, постобработка, крон), и тянуть импорт в каждый модуль ради
 * одного сервиса — лишняя церемония. Сервис ничего не требует от DI и
 * ничего не ломает, если каналы не настроены.
 */
import { Global, Module } from '@nestjs/common';
import { TelegramNotifyService } from './telegram-notify.service';

@Global()
@Module({
  providers: [TelegramNotifyService],
  exports: [TelegramNotifyService],
})
export class NotifyModule {}
