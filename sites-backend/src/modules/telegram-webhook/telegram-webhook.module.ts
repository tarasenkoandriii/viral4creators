import { Module } from '@nestjs/common';
import { AssistSiteHandoffModule } from '../assist-site-handoff/assist-site-handoff.module';
import { TelegramWebhookController } from './telegram-webhook.controller';

/** Э3 (H): обновления бота Помощника — AssistBotUpdates (передача человеку). */
@Module({
  imports: [AssistSiteHandoffModule],
  controllers: [TelegramWebhookController],
})
export class TelegramWebhookModule {}
