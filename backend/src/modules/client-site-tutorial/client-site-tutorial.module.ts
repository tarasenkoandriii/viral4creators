import { Module } from '@nestjs/common';
import { AdminAuthModule } from '../admin-auth/admin-auth.module';
import { AdminPanelModule } from '../admin-panel/admin-panel.module';
import { StorageModule } from '../storage/storage.module';
import { SitesInternalModule } from '../sites-internal/sites-internal.module';
import { ClientSiteMediaModule } from '../client-site-media/client-site-media.module';
import { ChromiumPageExplorer } from './chromium-page-explorer';
import { ClientSiteTutorialAdminController } from './client-site-tutorial-admin.controller';
import { ClientSiteTutorialAdminService } from './client-site-tutorial-admin.service';
import { ClientSiteTutorialController } from './client-site-tutorial.controller';
import { ClientSiteTutorialService } from './client-site-tutorial.service';
import { ClientSiteTutorialUsageService } from './client-site-tutorial-usage.service';
import { LiveLoginRelayClient } from './live-login-relay.client';
import { PAGE_EXPLORER } from './page-explorer';
import { ClientSiteAccessService } from './site-access.service';
import { ClientSiteTestAccountsController } from './client-site-test-accounts.controller';
import { ClientSiteTestAccountsService } from './client-site-test-accounts.service';
import {
  DraftSecretsStore,
  defaultDraftSecretsStore,
} from './draft-secrets-store';
import { PrismaService } from '../../prisma/prisma.service';
import { SitesInternalClient } from '../sites-internal/sites-internal.client';

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
 *
 * Э-С Ш1: `SitesInternalModule` — клиент внутреннего API sites-backend
 * (HMAC, без DSN `site_*`), `ClientSiteAccessService` — режим A/B и
 * подтверждение прав на аккаунт в режиме B (П-Т1, П-Т2).
 */
@Module({
  imports: [
    StorageModule,
    AdminAuthModule,
    AdminPanelModule,
    SitesInternalModule,
    // Э6 помощника: привязка к сайту помощника, ролики и карта интерфейса.
    ClientSiteMediaModule,
  ],
  controllers: [
    ClientSiteTutorialController,
    ClientSiteTutorialAdminController,
    // Э-С Ш2: экран «Тестовые учётные записи» мастера.
    ClientSiteTestAccountsController,
  ],
  providers: [
    ClientSiteTutorialService,
    ClientSiteTutorialUsageService,
    ClientSiteTutorialAdminService,
    LiveLoginRelayClient,
    ClientSiteAccessService,
    { provide: PAGE_EXPLORER, useClass: ChromiumPageExplorer },
    // Э-С Ш2: данные входа черновика — хранилище sites-backend или колонки.
    {
      provide: DraftSecretsStore,
      useFactory: (prisma: PrismaService, sites: SitesInternalClient) =>
        defaultDraftSecretsStore(prisma, sites),
      inject: [PrismaService, SitesInternalClient],
    },
    ClientSiteTestAccountsService,
  ],
  exports: [
    ClientSiteTutorialService,
    ClientSiteTutorialUsageService,
    // Съёмка кадров лендинга (ui-snapshot): служебное подтверждение прав
    // фикстуры по нашему домену — иначе мастер в режиме B ждёт галочку.
    ClientSiteAccessService,
  ],
})
export class ClientSiteTutorialModule {}
