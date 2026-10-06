import { Module } from '@nestjs/common';
import { AdminAuthModule } from '../admin-auth/admin-auth.module';
import { AdminPanelModule } from '../admin-panel/admin-panel.module';
import { CronModule } from '../cron/cron.module';
import { AdminCronService } from '../cron/admin-cron.service';
import { DemoStatusService } from '../ops-status/demo-status.service';
import { PlatformSettingsService } from '../../common/platform-settings.service';
import { AdminAttentionController } from './admin-attention.controller';
import { AdminAttentionService } from './admin-attention.service';

/**
 * Дашборд внимания (`GET /api/admin/attention`), только чтение.
 *
 * `AdminCronService` и `DemoStatusService` их модули не экспортируют —
 * здесь свои экземпляры: оба без состояния, зависят только от Prisma
 * (глобальна) и `CronJobsService` (экспортирован `CronModule`; у
 * сводки он не используется). Так чужие модули остаются нетронутыми.
 * `PlatformSettingsService` — тем же приёмом, что у остальных модулей,
 * которые читают настройки (список языков обучалки).
 */
@Module({
  imports: [AdminAuthModule, AdminPanelModule, CronModule],
  controllers: [AdminAttentionController],
  providers: [
    AdminAttentionService,
    AdminCronService,
    DemoStatusService,
    PlatformSettingsService,
  ],
})
export class AdminAttentionModule {}
