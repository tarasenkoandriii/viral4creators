/**
 * Внутренний API вкладки «Помощник» админки платформы (Э4; ТЗ §8 п.1–5, 8).
 * Генератор не получает DSN схемы `sites` — только этот API с секретом
 * (аудит слияния 02.10 §3.0 п.2).
 */
import { Module } from '@nestjs/common';
import { AssistBillingModule } from '../assist-billing/assist-billing.module';
import { BillingNotices } from '../assist-billing/billing-notices';
import { PlatformAdminController } from './platform-admin.controller';
import { PlatformAdmin } from './platform-admin.service';

@Module({
  imports: [AssistBillingModule],
  controllers: [PlatformAdminController],
  providers: [PlatformAdmin, BillingNotices],
})
export class PlatformAdminModule {}
