import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module';
import { NotifyModule } from '../notify/notify.module';
import { StorageModule } from '../storage/storage.module';
import { TelegramBotController } from './telegram-bot.controller';
import { TelegramBotService } from './telegram-bot.service';
import { TelegramFilesService } from './telegram-files.service';
import { TesterOnboardingService } from './tester-onboarding.service';
import { TesterTicketsService } from './tester-tickets.service';

/**
 * Единственный вебхук бота и всё, что он разбирает (этапы 155, 157).
 *
 * `BillingModule` — платежи, которые этот вебхук обслуживал до
 * появления диспетчера; `NotifyModule` — ответы в личку;
 * `StorageModule` (`BlobService`) — вложения тикетов. `PrismaService` —
 * global-модуль, явный импорт не требуется.
 */
@Module({
  imports: [BillingModule, NotifyModule, StorageModule],
  controllers: [TelegramBotController],
  providers: [
    TelegramBotService,
    TelegramFilesService,
    TesterOnboardingService,
    TesterTicketsService,
  ],
})
export class TelegramBotModule {}
