import { Module } from '@nestjs/common';
import { GenerationController } from './generation.controller';
import { AdminGenerationRetryController } from './admin-generation-retry.controller';
import { GenerationService } from './generation.service';
import { StorageModule } from '../storage/storage.module';
import { SharedVideoModule } from '../shared-video/shared-video.module';
import { AdminAuthModule } from '../admin-auth/admin-auth.module';
import { AdminPanelModule } from '../admin-panel/admin-panel.module';

/**
 * GenerationModule handles video generation operations.
 *
 * `SharedVideoModule` — этап 60: при первом завершении рендера сессии,
 * созданной по ссылке шеринга (`session.sharedFromPageId`), сервис
 * бампает счётчик конверсии страницы-источника.
 *
 * `AdminAuthModule`/`AdminPanelModule` — ради `AdminGenerationRetryController`
 * (доп. запрос владельца продукта: кнопка повтора провалившегося
 * рендера прямо из админки). Импорт односторонний — см. доккомментарий
 * самого контроллера за тем, почему это не сделано наоборот
 * (`AdminPanelModule` не может импортировать этот модуль без цикла
 * через `SharedVideoModule`).
 */
@Module({
  imports: [StorageModule, SharedVideoModule, AdminAuthModule, AdminPanelModule],
  controllers: [GenerationController, AdminGenerationRetryController],
  providers: [GenerationService],
  exports: [GenerationService],
})
export class GenerationModule {}
