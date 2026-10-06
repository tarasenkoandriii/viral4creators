import { Module } from '@nestjs/common';
import { AdminAuthModule } from '../admin-auth/admin-auth.module';
import { AdminPanelModule } from '../admin-panel/admin-panel.module';
import { OpsStatusController } from './ops-status.controller';
import { DemoStatusService } from './demo-status.service';

/**
 * Служебные сводки для оператора (`/api/ops/*`), только чтение.
 * `PrismaService` — глобальный модуль; админские модули — за гвардом и
 * `assertOperator`, тем же приёмом, что `UiSnapshotModule`.
 */
@Module({
  imports: [AdminAuthModule, AdminPanelModule],
  controllers: [OpsStatusController],
  providers: [DemoStatusService],
})
export class OpsStatusModule {}
