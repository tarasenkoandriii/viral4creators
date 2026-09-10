import { Module } from '@nestjs/common';
import { GenerationController } from './generation.controller';
import { GenerationService } from './generation.service';
import { StorageModule } from '../storage/storage.module';
import { SharedVideoModule } from '../shared-video/shared-video.module';

/**
 * GenerationModule handles video generation operations.
 *
 * `SharedVideoModule` — этап 60: при первом завершении рендера сессии,
 * созданной по ссылке шеринга (`session.sharedFromPageId`), сервис
 * бампает счётчик конверсии страницы-источника.
 */
@Module({
  imports: [StorageModule, SharedVideoModule],
  controllers: [GenerationController],
  providers: [GenerationService],
  exports: [GenerationService],
})
export class GenerationModule {}
