import { Module } from '@nestjs/common';
import { ProductFeedImportController } from './product-feed-import.controller';
import { ProductFeedImportService } from './product-feed-import.service';
import { ProductFeedImportWorkerService } from './product-feed-import-worker.service';
import { ProjectModule } from '../project/project.module';
import { StorageModule } from '../storage/storage.module';

/**
 * ProductFeedImportModule — импорт товарного фида по ссылке (TODO
 * §Уровень 2 п.8, этап 68, §47).
 *
 * `PrismaModule`/`PlanModule` — `@Global()`, ничего импортировать не
 * нужно (тот же принцип, что у `CatalogBatchModule`). `ProjectModule` —
 * за `ProjectService.addItem` (переиспользуется воркером напрямую, не
 * копируется). `StorageModule` — за `BlobService` (сохранение фото,
 * скачанного по ссылке из фида).
 */
@Module({
  imports: [ProjectModule, StorageModule],
  controllers: [ProductFeedImportController],
  providers: [ProductFeedImportService, ProductFeedImportWorkerService],
  exports: [ProductFeedImportService, ProductFeedImportWorkerService],
})
export class ProductFeedImportModule {}
