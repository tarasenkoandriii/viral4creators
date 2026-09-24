import { Module } from '@nestjs/common';
import { GenerationController } from './generation.controller';
import { GenerationPublicSettingsController } from './generation-public-settings.controller';
import { AdminVideoProviderSettingsService } from '../admin-panel/admin-video-provider-settings.service';
import { AdminGenerationRetryController } from './admin-generation-retry.controller';
import { GenerationService } from './generation.service';
import { SnapshotVoiceSyncService } from './snapshot-voice-sync.service';
import { GrokVideoService } from './grok-video.service';
import { GrokVideoBatchService } from './grok-video-batch.service';
import { StorageModule } from '../storage/storage.module';
import { SharedVideoModule } from '../shared-video/shared-video.module';
import { AdminAuthModule } from '../admin-auth/admin-auth.module';
import { AdminPanelModule } from '../admin-panel/admin-panel.module';
import { VideoAuditModule } from '../video-audit/video-audit.module';
import { PromptModule } from '../prompt/prompt.module';
import { RenderAccessModule } from '../render-access/render-access.module';

/**
 * GenerationModule handles video generation operations.
 *
 * `SharedVideoModule` — этап 60: при первом завершении рендера сессии,
 * созданной по ссылке шеринга (`session.sharedFromPageId`), сервис
 * бампает счётчик конверсии страницы-источника.
 *
 * `AdminAuthModule`/`AdminPanelModule`/`VideoAuditModule`/`PromptModule`
 * — ради `AdminGenerationRetryController` (доп. запрос владельца
 * продукта: повтор рендера, проверка на артефакты и «применить
 * исправление и перегенерировать» прямо из админки). Импорт
 * односторонний — см. доккомментарий самого контроллера за тем, почему
 * это не сделано наоборот (`AdminPanelModule` не может импортировать
 * этот модуль без цикла через `SharedVideoModule`). `VideoAuditModule`
 * тянет только `StorageModule`, `PromptModule` не тянет вообще ничего —
 * ни один цикла не создаёт.
 *
 * `GrokVideoBatchService` (§13 ТЗ, этап 2 плана §14) — экспортирован
 * для `CatalogBatchModule` (единственный на сегодня потребитель —
 * `CatalogBatchWorkerService`, партии по каталогу).
 */
@Module({
  imports: [
    StorageModule,
    SharedVideoModule,
    AdminAuthModule,
    AdminPanelModule,
    VideoAuditModule,
    PromptModule,
    // Этап 132: право на рендер — одно на все старты рендера продукта.
    RenderAccessModule,
  ],
  controllers: [
    GenerationController,
    AdminGenerationRetryController,
    GenerationPublicSettingsController,
  ],
  providers: [
    GenerationService,
    SnapshotVoiceSyncService,
    GrokVideoService,
    GrokVideoBatchService,
    AdminVideoProviderSettingsService,
  ],
  exports: [GenerationService, GrokVideoBatchService],
})
export class GenerationModule {}
