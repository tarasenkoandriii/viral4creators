import { Module } from '@nestjs/common';
import { CronController } from './cron.controller';
import { CronJobsService } from './cron-jobs.service';
import { AdminCronController } from './admin-cron.controller';
import { AdminCronService } from './admin-cron.service';
import { StorageModule } from '../storage/storage.module';
import { AiUsageModule } from '../ai-usage/ai-usage.module';
import { AdminPanelModule } from '../admin-panel/admin-panel.module';
import { AdminAuthModule } from '../admin-auth/admin-auth.module';
import { LibraryModule } from '../library/library.module';
import { BlogModule } from '../blog/blog.module';
import { PublishingModule } from '../publishing/publishing.module';
import { BillingRenewalModule } from '../billing-renewal/billing-renewal.module';
import { MarketingModule } from '../marketing/marketing.module';
import { CatalogBatchModule } from '../catalog-batch/catalog-batch.module';
import { AbTestModule } from '../ab-test/ab-test.module';
import { ProductFeedImportModule } from '../product-feed-import/product-feed-import.module';
import { ExportModule } from '../export/export.module';
import { ProjectModule } from '../project/project.module';
import { TutorialScenarioModule } from '../tutorial-scenario/tutorial-scenario.module';
import { TutorialRunnerModule } from '../tutorial-runner/tutorial-runner.module';
import { UiSnapshotModule } from '../ui-snapshot/ui-snapshot.module';
import { ImageSketchModule } from '../image-sketch/image-sketch.module';
import { AuctionModule } from '../auction/auction.module';
import { PortfolioModule } from '../portfolio/portfolio.module';
import { ApiKeyModule } from '../api-key/api-key.module';

/**
 * CronModule
 *
 * Houses endpoints meant for Vercel Cron Jobs, not end users — see
 * CronController's doc comment and backend/vercel.json.
 */
@Module({
  // StorageModule — за BlobService: уборка сессий удаляет и их файлы
  // (doc/STORAGE-AUDIT.md, этап 26).
  // AiUsageModule и AdminPanelModule — за числами для суточного отчёта
  // в канал статистики (ТЗ §28, этап 45).
  // LibraryModule — за чисткой невостребованных разборов (этап 51, В-4.6).
  // BlogModule — за суточным кроном генерации/перевода блога (этап 57).
  // PublishingModule — за воркером выгрузки в YouTube/TikTok (этап 61).
  // BillingRenewalModule — за воркером продления подписок (этап 62).
  // MarketingModule — за воркером рассылки подборки роликов (этап 63).
  // CatalogBatchModule — за воркером пакетной генерации по каталогу
  // (этап 65).
  // AbTestModule — за воркером A/B-вариантов одного ролика (этап 66).
  // ProductFeedImportModule — за воркером импорта товарного фида (этап 68).
  // ExportModule — за крон-аналогом advanceGenerating для автоэкспорта
  // яруса B (этап 76, Е-2.3 шестого аудита).
  // ProjectModule — за purgeSoftDeletedProjects/purgeSoftDeletedItems
  // (этап 89): та же суточная уборка (`runCleanupSessions`), что убирает
  // мягко удалённые сессии, теперь физически убирает и мягко удалённые
  // Project/ProductItem — ProjectService уже держит свой BlobService.
  // TutorialScenarioModule — за TutorialScenarioGeneratorService (этап
  // 94, doc/TMA-UI-SNAPSHOT-AND-TUTORIAL-VIDEO-SPEC.md §4.10) — генерация
  // сценариев для будущей автозаписи обучающих видео, тот же приём
  // делегирования, что у остальных крон-воркеров этого списка.
  // TutorialRunnerModule — за TutorialScenarioRunnerService (этап 97,
  // §5 того же ТЗ) — исполнение уже сгенерированных сценариев headless-
  // браузером против фикстурного пользователя, отдельный крон-слот от
  // генерации (см. доккомментарий TutorialRunnerModule).
  // UiSnapshotModule — за UiSnapshotRunnerService (этап 100, §3 того же
  // ТЗ, «Фаза 1») — крон-обход интерфейса TMA и слежение за внешним
  // видом, отдельный крон-слот и от генерации сценариев, и от
  // исполнения (см. доккомментарий UiSnapshotModule).
  // AuctionModule — за AuctionService.closeExpiredListings и
  // AuctionAiAssessmentService.runTick (ТЗ на маркетплейс §22, Этапы
  // 2–3) — закрытие лотов по дедлайну и ИИ-оценка заявок, тот же
  // тик-приём, что у остальных /cron/*-run воркеров этого списка.
  // Также LiveAuctionOrchestratorService.collapseInactiveStreams (ТЗ на
  // живой аукцион §7.5, Этап 5) — авто-сворачивание трансляций без
  // ставок, тот же тик-приём.
  // AdminAuthModule — за AdminSessionGuard для нового AdminCronController
  // (этап 69, ручной запуск кронов из админки). Лист графа модулей (сам
  // ничего не импортирует) — довесить его сюда не создаёт цикла, в
  // отличие от варианта «дать AdminPanelModule инжектить логику кронов»
  // (тогда AdminPanelModule → CronModule → AdminPanelModule) — см.
  // doc/PRODUCT-PROJECT-SPEC.md §69.
  imports: [
    ImageSketchModule,
    StorageModule,
    AiUsageModule,
    AdminPanelModule,
    AdminAuthModule,
    LibraryModule,
    BlogModule,
    PublishingModule,
    BillingRenewalModule,
    MarketingModule,
    CatalogBatchModule,
    AbTestModule,
    ProductFeedImportModule,
    ExportModule,
    ProjectModule,
    TutorialScenarioModule,
    TutorialRunnerModule,
    UiSnapshotModule,
    AuctionModule,
    PortfolioModule,
    // Этап 145: воркер заявок внешнего API.
    ApiKeyModule,
  ],
  controllers: [CronController, AdminCronController],
  providers: [CronJobsService, AdminCronService],
  // Экспортируется на случай, если что-то ещё захочет переиспользовать
  // логику кронов — сегодня не требуется никем, но дёшево.
  exports: [CronJobsService],
})
export class CronModule {}
