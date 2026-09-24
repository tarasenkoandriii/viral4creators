import { Module } from '@nestjs/common';
import { CatalogBatchController } from './catalog-batch.controller';
import { CatalogBatchService } from './catalog-batch.service';
import { CatalogBatchWorkerService } from './catalog-batch-worker.service';
import { ProjectSessionModule } from '../project-session/project-session.module';
import { LibraryModule } from '../library/library.module';
import { PromptModule } from '../prompt/prompt.module';
import { GenerationModule } from '../generation/generation.module';
import { StorageModule } from '../storage/storage.module';
import { RenderAccessModule } from '../render-access/render-access.module';

/**
 * CatalogBatchModule — пакетная генерация по каталогу (ТЗ §44, этап 65).
 *
 * `PrismaModule`/`PlanModule` — `@Global()`, ничего импортировать не
 * нужно. `ProjectSessionModule`/`LibraryModule`/`PromptModule`/
 * `GenerationModule` — НЕ `@Global()` (тот же приём, что у
 * `BillingModule` → `LegalModule`, этап 64), поэтому импортируются явно.
 * `StorageModule` (§13 ТЗ, этап 2 плана §14) — `BlobService`, нужен
 * воркеру самому сохранять готовое видео из результатов xAI-пачки
 * (Grok batch не проходит через `GenerationService.getVideoStatus()`,
 * который делает это для синхронного пути).
 */
@Module({
  imports: [
    ProjectSessionModule,
    LibraryModule,
    PromptModule,
    GenerationModule,
    StorageModule,
    // Этап 132: право на рендер — партия его требует целиком.
    RenderAccessModule,
  ],
  controllers: [CatalogBatchController],
  providers: [CatalogBatchService, CatalogBatchWorkerService],
  exports: [CatalogBatchService, CatalogBatchWorkerService],
})
export class CatalogBatchModule {}
