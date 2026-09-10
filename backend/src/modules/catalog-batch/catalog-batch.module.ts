import { Module } from '@nestjs/common';
import { CatalogBatchController } from './catalog-batch.controller';
import { CatalogBatchService } from './catalog-batch.service';
import { CatalogBatchWorkerService } from './catalog-batch-worker.service';
import { ProjectSessionModule } from '../project-session/project-session.module';
import { LibraryModule } from '../library/library.module';
import { PromptModule } from '../prompt/prompt.module';
import { GenerationModule } from '../generation/generation.module';

/**
 * CatalogBatchModule — пакетная генерация по каталогу (ТЗ §44, этап 65).
 *
 * `PrismaModule`/`PlanModule` — `@Global()`, ничего импортировать не
 * нужно. `ProjectSessionModule`/`LibraryModule`/`PromptModule`/
 * `GenerationModule` — НЕ `@Global()` (тот же приём, что у
 * `BillingModule` → `LegalModule`, этап 64), поэтому импортируются явно.
 */
@Module({
  imports: [
    ProjectSessionModule,
    LibraryModule,
    PromptModule,
    GenerationModule,
  ],
  controllers: [CatalogBatchController],
  providers: [CatalogBatchService, CatalogBatchWorkerService],
  exports: [CatalogBatchService, CatalogBatchWorkerService],
})
export class CatalogBatchModule {}
