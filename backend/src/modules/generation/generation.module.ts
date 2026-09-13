import { Module } from '@nestjs/common';
import { GenerationController } from './generation.controller';
import { AdminGenerationRetryController } from './admin-generation-retry.controller';
import { GenerationService } from './generation.service';
import { GrokVideoService } from './grok-video.service';
import { GrokVideoBatchService } from './grok-video-batch.service';
import { StorageModule } from '../storage/storage.module';
import { SharedVideoModule } from '../shared-video/shared-video.module';
import { AdminAuthModule } from '../admin-auth/admin-auth.module';
import { AdminPanelModule } from '../admin-panel/admin-panel.module';
import { VideoAuditModule } from '../video-audit/video-audit.module';
import { PromptModule } from '../prompt/prompt.module';

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
 * `GrokVideoBatchService` (§13 ТЗ, этап 2 плана §14) — зарегистрирован
 * здесь как готовый клиент, но НЕ подключён к
 * `CatalogBatchWorkerService` в этом заходе и НЕ экспортирован из
 * модуля — само подключение (какой из существующих циклов claim'ит
 * работу под него, как получать URL готового видео из ответа батча в
 * рамках `getVideoStatus`) требует более широкой, отдельной правки
 * `catalog-batch`-модуля, которую этот заход сознательно не трогает
 * (доп. риск для уже работающего кода без реальной проверки формата
 * ответа xAI — см. доккомментарий самого сервиса).
 */
@Module({
  imports: [
    StorageModule,
    SharedVideoModule,
    AdminAuthModule,
    AdminPanelModule,
    VideoAuditModule,
    PromptModule,
  ],
  controllers: [GenerationController, AdminGenerationRetryController],
  providers: [GenerationService, GrokVideoService, GrokVideoBatchService],
  exports: [GenerationService],
})
export class GenerationModule {}
