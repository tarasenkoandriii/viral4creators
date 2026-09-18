import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { ImageSketchController } from './image-sketch.controller';
import { ImageSketchService } from './image-sketch.service';
import { SketchGeneratorService } from './sketch-generator.service';
import { SketchTargetsService } from './sketch-targets';

/**
 * ImageSketchModule — ИИ-скетч вместо изображения
 * (doc/AI-SKETCH-SPEC.md). `PlanService`, `AiUsageService` и
 * `SessionService` глобальные; из своего нужен только Blob.
 */
@Module({
  imports: [StorageModule],
  controllers: [ImageSketchController],
  providers: [ImageSketchService, SketchGeneratorService, SketchTargetsService],
  exports: [ImageSketchService, SketchTargetsService],
})
export class ImageSketchModule {}
