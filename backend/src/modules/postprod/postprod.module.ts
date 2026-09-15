import { Global, Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { PlanModule } from '../plan/plan.module';
import { FfmpegApiService } from './ffmpeg-api.service';
import { PostProductionService } from './postprod.service';
import { PostProdController } from './postprod.controller';
import { PostprodVideosController } from './postprod-videos.controller';
import { PostprodVideosService } from './postprod-videos.service';

/**
 * Постобработка ролика (ТЗ §15.4/§16.1). Global по той же причине, что
 * PlanModule: зовёт её только генерация, но держать её внутри модуля
 * генерации значило бы смешать «снять ролик» и «довести его» — это
 * разные вещи с разными внешними сервисами.
 *
 * Контроллер (этап 87 — переозвучка без перегенерации) появился только
 * сейчас: до этого модуль вызывался исключительно изнутри (генерация,
 * экспорт, аватар) и своего HTTP-входа не имел вовсе.
 *
 * `PostprodVideosController`/`Service` (этап 88 — вкладка «Постпрод» в
 * TMA) — отдельная пара файлов, а не метод на `PostProdController`:
 * тот работает на одной уже открытой сессии (`:sessionId` в пути), а
 * это — collection-level список «все мои ролики», со своей моделью
 * доступа (`TelegramIdentityGuard`, не «id сессии как токен доступа»).
 */
@Global()
@Module({
  imports: [StorageModule, PlanModule],
  controllers: [PostProdController, PostprodVideosController],
  providers: [FfmpegApiService, PostProductionService, PostprodVideosService],
  exports: [FfmpegApiService, PostProductionService],
})
export class PostProductionModule {}
