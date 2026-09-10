import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { AdminAuthModule } from '../admin-auth/admin-auth.module';
import { AdminPanelModule } from '../admin-panel/admin-panel.module';
import { LibraryModule } from '../library/library.module';
import {
  AdminSharedVideoController,
  PublicSharedVideoController,
  SharedVideoController,
} from './shared-video.controller';
import { SharedVideoService } from './shared-video.service';

/**
 * SharedVideoModule — публичная страница ролика и петля шеринга (ТЗ §40,
 * этап 60). `LibraryModule` — форк-сторона применяет разбор через
 * `LibraryService.applyEntryToSessionFree`; экспортирует сервис, потому
 * что `GenerationService` (другой модуль) вызывает `markConverted` при
 * завершении рендера.
 */
@Module({
  imports: [AdminAuthModule, AdminPanelModule, StorageModule, LibraryModule],
  controllers: [
    SharedVideoController,
    PublicSharedVideoController,
    AdminSharedVideoController,
  ],
  providers: [SharedVideoService],
  exports: [SharedVideoService],
})
export class SharedVideoModule {}
