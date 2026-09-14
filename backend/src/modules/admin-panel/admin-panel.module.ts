import { Module } from '@nestjs/common';
import { AdminAuthModule } from '../admin-auth/admin-auth.module';
import { StorageModule } from '../storage/storage.module';
import { AdminPanelController } from './admin-panel.controller';
import { AdminPanelService } from './admin-panel.service';
import { AdminUsersService } from './admin-users.service';
import { AdminBillingService } from './admin-billing.service';
import { AdminMarketingService } from './admin-marketing.service';
import { AdminCatalogBatchService } from './admin-catalog-batch.service';
import { AdminAbTestService } from './admin-ab-test.service';
import { AdminFeedImportService } from './admin-feed-import.service';
import { AdminVoiceoverSettingsService } from './admin-voiceover-settings.service';
import { AdminAnalysisSettingsService } from './admin-analysis-settings.service';
import { AdminVideoProviderSettingsService } from './admin-video-provider-settings.service';

@Module({
  // StorageModule — удаление сессии оператором уносит и её файлы (Б-5.9).
  // TelegramStarsService (AdminBillingService.refund(),
  // AdminUsersService.cancelSubscription()) с этапа 64 доступен глобально
  // через TelegramStarsModule (Г-2.2 аудита round4) — импортировать
  // BillingModule ради него больше не нужно. ElevenLabsService/
  // ResembleService/PlatformSettingsService (AdminVoiceoverSettingsService)
  // доступны так же глобально через TtsModule — импортировать его здесь
  // не нужно по той же причине.
  //
  // GenerationModule НЕ импортирован здесь нарочно: он тянет
  // SharedVideoModule, а тот сам импортирует AdminPanelModule (ради
  // AdminSharedVideoController) — импорт в обратную сторону замкнул бы
  // цикл AdminPanelModule → GenerationModule → SharedVideoModule →
  // AdminPanelModule. Правило проекта одностороннее (см.
  // SharedVideoModule): admin-контроллер конкретной фичи живёт В МОДУЛЕ
  // этой фичи и импортирует AdminPanelModule сам, а не наоборот —
  // поэтому кнопка повтора рендера (доп. запрос владельца продукта)
  // реализована как отдельный контроллер в GenerationModule
  // (admin-retry.controller.ts), а не как метод здесь.
  imports: [AdminAuthModule, StorageModule],
  controllers: [AdminPanelController],
  providers: [
    AdminPanelService,
    AdminUsersService,
    AdminBillingService,
    // AdminMarketingService/AdminCatalogBatchService/AdminAbTestService/
    // AdminFeedImportService — только PrismaService, отдельного модуля не
    // требуют (этапы 63/65/66/68).
    AdminMarketingService,
    AdminCatalogBatchService,
    AdminAbTestService,
    AdminFeedImportService,
    AdminVoiceoverSettingsService,
    AdminAnalysisSettingsService,
    AdminVideoProviderSettingsService,
  ],
  // Суточный отчёт крона берёт телеметрию отсюда (ТЗ §28, этап 45).
  exports: [AdminPanelService],
})
export class AdminPanelModule {}
