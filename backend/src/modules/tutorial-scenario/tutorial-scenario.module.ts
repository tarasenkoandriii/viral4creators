import { Module } from '@nestjs/common';
import { AdminAuthModule } from '../admin-auth/admin-auth.module';
import { AdminPanelModule } from '../admin-panel/admin-panel.module';
import { TutorialScenarioAdminController } from './tutorial-scenario-admin.controller';
import { TutorialScenarioAdminService } from './tutorial-scenario-admin.service';
import { TutorialScenarioGeneratorService } from './tutorial-scenario-generator.service';

/**
 * TutorialScenarioModule — генератор сценариев для автозаписи обучающих
 * видео (doc/TMA-UI-SNAPSHOT-AND-TUTORIAL-VIDEO-SPEC.md §4.10/§4.11,
 * этап 94). `PrismaService`/`AiUsageService` — global-модули (см.
 * `prisma.module.ts`/`ai-usage.module.ts`), явный импорт не требуется —
 * тот же приём, что и у остальных фиче-модулей проекта.
 *
 * `TutorialScenarioGeneratorService` экспортируется — его вызывает
 * `CronJobsService` (см. `cron.module.ts`, тем же способом, что
 * `ExportModule`/`CatalogBatchModule` и остальные крон-воркеры).
 */
@Module({
  imports: [AdminAuthModule, AdminPanelModule],
  controllers: [TutorialScenarioAdminController],
  providers: [TutorialScenarioGeneratorService, TutorialScenarioAdminService],
  exports: [TutorialScenarioGeneratorService],
})
export class TutorialScenarioModule {}
