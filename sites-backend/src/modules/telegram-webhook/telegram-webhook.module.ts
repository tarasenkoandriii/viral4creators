import { Module } from '@nestjs/common';
import { AssistBillingModule } from '../assist-billing/assist-billing.module';
import { AssistSiteHandoffModule } from '../assist-site-handoff/assist-site-handoff.module';
import { TelegramWebhookController } from './telegram-webhook.controller';

/**
 * Э3 (H): обновления бота Помощника — AssistBotUpdates (передача человеку).
 * Э4: pre_checkout_query / successful_payment — AssistPayments (Stars).
 */
@Module({
  imports: [AssistSiteHandoffModule, AssistBillingModule],
  controllers: [TelegramWebhookController],
})
export class TelegramWebhookModule {}
