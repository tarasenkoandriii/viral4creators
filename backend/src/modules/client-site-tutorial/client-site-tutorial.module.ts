import { Module } from '@nestjs/common';
import { AdminAuthModule } from '../admin-auth/admin-auth.module';
import { AdminPanelModule } from '../admin-panel/admin-panel.module';
import { StorageModule } from '../storage/storage.module';
import { ChromiumPageExplorer } from './chromium-page-explorer';
import { ClientSiteTutorialAdminController } from './client-site-tutorial-admin.controller';
import { ClientSiteTutorialAdminService } from './client-site-tutorial-admin.service';
import { ClientSiteTutorialController } from './client-site-tutorial.controller';
import { ClientSiteTutorialService } from './client-site-tutorial.service';
import { ClientSiteTutorialUsageService } from './client-site-tutorial-usage.service';
import { LiveLoginRelayClient } from './live-login-relay.client';
import { PAGE_EXPLORER } from './page-explorer';

/**
 * Обучалка по сайту заказчика (doc/CLIENT-SITE-TUTORIAL-SPEC.md; этап
 * 111 — оркестрация, 112 — браузерная часть, 113 — завершение и
 * модерация, 114 — живой вход через отдельный сервис-реле).
 *
 * `PrismaModule`/`PlanModule`/`PostProductionModule` (`FfmpegApiService`)
 * глобальные — явно не импортируются (та же конвенция, что у остальных
 * фиче-модулей). `StorageModule` (`BlobService` — кадры предпросмотра в
 * Blob, §5.2 `/finish`) и `AdminAuthModule`/`AdminPanelModule`
 * (`AdminSessionGuard`/`assertOperator` для очереди модерации, §8.3)
 * глобальными не являются и импортируются явно — тот же набор, что у
 * `TutorialRunnerModule`.
 *
 * `PAGE_EXPLORER` — единственная точка, где оркестрация встречается с
 * Chromium. Граница заведена интерфейсом именно ради этой строки: этап
 * 111 держал здесь заглушку, отвечавшую 503, и её замена включила фичу
 * целиком, без единой правки в сервисе и без единой правки в его тестах
 * (см. `page-explorer.ts`).
 */
@Module({
  imports: [StorageModule, AdminAuthModule, AdminPanelModule],
  controllers: [
    ClientSiteTutorialController,
    ClientSiteTutorialAdminController,
  ],
  providers: [
    ClientSiteTutorialService,
    ClientSiteTutorialUsageService,
    ClientSiteTutorialAdminService,
    LiveLoginRelayClient,
    { provide: PAGE_EXPLORER, useClass: ChromiumPageExplorer },
  ],
  exports: [ClientSiteTutorialService, ClientSiteTutorialUsageService],
})
export class ClientSiteTutorialModule {}
