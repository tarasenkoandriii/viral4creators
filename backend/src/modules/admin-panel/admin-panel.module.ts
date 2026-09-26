import { Module } from '@nestjs/common';
import { WizardGuideModule } from '../wizard-guide/wizard-guide.module';
import { AdminAuthModule } from '../admin-auth/admin-auth.module';
import { AdminPanelController } from './admin-panel.controller';
import { AdminPanelService } from './admin-panel.service';
import { AdminUsersService } from './admin-users.service';
import { AdminBillingService } from './admin-billing.service';
import { AdminMarketingService } from './admin-marketing.service';
import { AdminCatalogBatchService } from './admin-catalog-batch.service';
import { AdminAbTestService } from './admin-ab-test.service';
import { AdminFeedImportService } from './admin-feed-import.service';
import { AdminVoiceoverSettingsService } from './admin-voiceover-settings.service';
import { AdminAudioSeparationSettingsService } from './admin-audio-separation-settings.service';
import { AudioSeparationModule } from '../audio-separation/audio-separation.module';
import { AdminMusicCatalogService } from './admin-music-catalog.service';
import { ProviderBalancesService } from './provider-balances.service';
import { AdminAnalysisSettingsService } from './admin-analysis-settings.service';
import { AdminVideoProviderSettingsService } from './admin-video-provider-settings.service';
import { AdminGrokTransportSettingsService } from './admin-grok-transport-settings.service';
import { AdminReferralsService } from './admin-referrals.service';
import { InviteModule } from '../invite/invite.module';
import { AdminTesterInvitesService } from './admin-tester-invites.service';
import { AdminTestTicketsService } from './admin-test-tickets.service';

@Module({
  // StorageModule здесь больше не нужен (этап 89): удаление сессии
  // оператором раньше уносило и её файлы синхронно (Б-5.9), напрямую
  // через `BlobService`; теперь `AdminPanelService.deleteSession` зовёт
  // `SessionService.softDeleteSession` (доступен глобально, `AppModule`)
  // — файлы физически убирает крон-уборка (`purgeSoftDeletedSessions`,
  // `CronModule`, у него свой `StorageModule`), не этот модуль.
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
  // InviteModule — ради `LiteUnlockService`: отзыв разблокировки и
  // возврат её после отзыва (этап 135) обязаны ходить тем же путём, что
  // и автоматическая разблокировка, иначе правило «право считается по
  // паре дат» пришлось бы написать дважды. Цикла нет: `InviteModule`
  // про админку не знает.
  // AudioSeparationModule — ради выключателя «Фон при дубляже»
  // (docs-tz/TZ-Voice-Replace-Keep-Background.md, этап E). Цикла нет:
  // модуль разделения про админку не знает.
  imports: [
    WizardGuideModule,
    AdminAuthModule,
    InviteModule,
    AudioSeparationModule,
  ],
  controllers: [AdminPanelController],
  providers: [
    AdminTesterInvitesService,
    AdminTestTicketsService,
    ProviderBalancesService,
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
    AdminAudioSeparationSettingsService,
    AdminMusicCatalogService,
    AdminAnalysisSettingsService,
    AdminVideoProviderSettingsService,
    AdminGrokTransportSettingsService,
    AdminReferralsService,
  ],
  // Суточный отчёт крона берёт телеметрию отсюда (ТЗ §28, этап 45).
  // `ProviderBalancesService` наружу — за ним ходит крон-сторож
  // остатков (этап 143), а `CronModule` уже импортирует этот модуль.
  exports: [AdminPanelService, ProviderBalancesService],
})
export class AdminPanelModule {}
