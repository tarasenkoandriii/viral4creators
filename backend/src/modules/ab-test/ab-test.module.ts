import { Module } from '@nestjs/common';
import { AbTestController } from './ab-test.controller';
import { AbTestService } from './ab-test.service';
import { AbTestWorkerService } from './ab-test-worker.service';
import { ProjectSessionModule } from '../project-session/project-session.module';
import { LibraryModule } from '../library/library.module';
import { PromptModule } from '../prompt/prompt.module';
import { GenerationModule } from '../generation/generation.module';

/**
 * AbTestModule — A/B-варианты одного ролика (TODO §III.6, этап 66).
 *
 * `PrismaModule`/`PlanModule` — `@Global()`, ничего импортировать не
 * нужно. `ProjectSessionModule`/`LibraryModule`/`PromptModule`/
 * `GenerationModule` — НЕ `@Global()` (тот же приём, что у
 * `CatalogBatchModule`, этап 65), поэтому импортируются явно.
 */
@Module({
  imports: [
    ProjectSessionModule,
    LibraryModule,
    PromptModule,
    GenerationModule,
  ],
  controllers: [AbTestController],
  providers: [AbTestService, AbTestWorkerService],
  exports: [AbTestService, AbTestWorkerService],
})
export class AbTestModule {}
