import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { PostProductionModule } from '../postprod/postprod.module';
import { AdminAuthModule } from '../admin-auth/admin-auth.module';
import { AdminPanelModule } from '../admin-panel/admin-panel.module';
import { LibraryModule } from '../library/library.module';
import {
  AdminSharedVideoController,
  PublicSharedVideoController,
  SharedVideoController,
  SharedVideoLikeController,
} from './shared-video.controller';
import { SharedVideoService } from './shared-video.service';
import { SharedVideoPosterService } from './shared-video-poster.service';

/**
 * SharedVideoModule — публичная страница ролика и петля шеринга (ТЗ §40,
 * этап 60), с этапа 80 — и лента/лайки/репосты (TODO §III.9,
 * doc/SOCIAL-FEED-SPEC.md). `LibraryModule` — форк-сторона применяет
 * разбор через `LibraryService.applyEntryToSessionFree`; экспортирует
 * сервис, потому что `GenerationService` (другой модуль) вызывает
 * `markConverted` при завершении рендера.
 */
@Module({
  imports: [
    AdminAuthModule,
    AdminPanelModule,
    StorageModule,
    LibraryModule,
    // Кадр-постер при публикации — `FfmpegApiService` живёт там.
    PostProductionModule,
  ],
  controllers: [
    SharedVideoController,
    PublicSharedVideoController,
    SharedVideoLikeController,
    AdminSharedVideoController,
  ],
  providers: [SharedVideoService, SharedVideoPosterService],
  exports: [SharedVideoService],
})
export class SharedVideoModule {}
