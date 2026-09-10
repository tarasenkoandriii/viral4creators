import { Module } from '@nestjs/common';
import { ExportController } from './export.controller';
import { ExportService } from './export.service';
import { PromptModule } from '../prompt/prompt.module';
import { GenerationModule } from '../generation/generation.module';

/**
 * ExportModule — автоэкспорт под площадки (TODO §III, п.35, этап 75).
 * `PlanModule`/`PostProductionModule` — `@Global()`, ничего импортировать
 * не нужно (тот же приём, что у `AbTestModule`/`CatalogBatchModule`).
 */
@Module({
  imports: [PromptModule, GenerationModule],
  controllers: [ExportController],
  providers: [ExportService],
  exports: [ExportService],
})
export class ExportModule {}
