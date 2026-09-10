import { Global, Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { PlanModule } from '../plan/plan.module';
import { FfmpegApiService } from './ffmpeg-api.service';
import { PostProductionService } from './postprod.service';

/**
 * Постобработка ролика (ТЗ §15.4/§16.1). Global по той же причине, что
 * PlanModule: зовёт её только генерация, но держать её внутри модуля
 * генерации значило бы смешать «снять ролик» и «довести его» — это
 * разные вещи с разными внешними сервисами.
 */
@Global()
@Module({
  imports: [StorageModule, PlanModule],
  providers: [FfmpegApiService, PostProductionService],
  exports: [FfmpegApiService, PostProductionService],
})
export class PostProductionModule {}
