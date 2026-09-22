import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { AiUsageModule } from '../ai-usage/ai-usage.module';
import { SketchGeneratorService } from '../image-sketch/sketch-generator.service';
import { GreetingReferenceController } from './greeting-reference.controller';
import { GreetingReferenceService } from './greeting-reference.service';

/** Reference images for Grok reference-to-video on GREETING_VIDEO sessions. */
@Module({
  imports: [StorageModule, AiUsageModule],
  controllers: [GreetingReferenceController],
  // `SketchGeneratorService` берётся напрямую, а не через
  // `ImageSketchModule`: нужен только вызов модели изображений, а весь
  // остальной скетч-модуль (квоты, история, применение к слотам) к
  // референс-кадру поздравления отношения не имеет.
  providers: [GreetingReferenceService, SketchGeneratorService],
  exports: [GreetingReferenceService],
})
export class GreetingReferenceModule {}
