import { Module } from '@nestjs/common';
import { AdminAuthModule } from '../admin-auth/admin-auth.module';
import { AdminPanelModule } from '../admin-panel/admin-panel.module';
import { StorageModule } from '../storage/storage.module';
import { GeminiFilesService } from '../analysis/gemini-files.service';
import { DemoQualityAdminController } from './demo-quality-admin.controller';
import {
  DemoQualityGemini,
  GoogleDemoQualityGemini,
} from './demo-quality-gemini';
import { TutorialDemoQualityService } from './demo-quality.service';

/**
 * Проверка качества демо обучалки через Gemini
 * (doc/TUTORIAL-DEMO-QUALITY-SPEC.md, 06.10.2026).
 *
 * Сервис экспортируется в `TutorialRunnerModule`: опрос сборок ставит
 * новый собранный ролик в очередь и в каждом тике отдаёт очереди
 * ограниченный кусок времени. `PrismaService` и `AiUsageService` —
 * глобальные; `StorageModule` (скачивание ролика) и модули админской
 * защиты — явно, тем же приёмом, что у `TutorialRunnerModule`.
 * `GeminiFilesService` — своим экземпляром, как у `VideoAuditModule`.
 */
@Module({
  imports: [StorageModule, AdminAuthModule, AdminPanelModule],
  controllers: [DemoQualityAdminController],
  providers: [
    TutorialDemoQualityService,
    GeminiFilesService,
    { provide: DemoQualityGemini, useClass: GoogleDemoQualityGemini },
  ],
  exports: [TutorialDemoQualityService],
})
export class TutorialQualityModule {}
