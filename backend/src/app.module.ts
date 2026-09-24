/**
 * AppModule
 *
 * Root application module that imports all feature modules.
 */

import { Module, Global, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { PrismaModule } from './prisma/prisma.module';
import { StorageModule } from './modules/storage/storage.module';
import { VideoModule } from './modules/video/video.module';
import { AnalysisModule } from './modules/analysis/analysis.module';
import { SessionsModule } from './modules/sessions/sessions.module';
import { ProductModule } from './modules/product/product.module';
import { PromptModule } from './modules/prompt/prompt.module';
import { GenerationModule } from './modules/generation/generation.module';
import { CronModule } from './modules/cron/cron.module';
import { TelegramAuthModule } from './modules/telegram-auth/telegram-auth.module';
import { TelegramIdentityMiddleware } from './modules/telegram-auth/telegram-identity.middleware';
import { AdminAuthModule } from './modules/admin-auth/admin-auth.module';
import { AdminPanelModule } from './modules/admin-panel/admin-panel.module';
import { TelegramLoginModule } from './modules/telegram-login/telegram-login.module';
import { ProjectModule } from './modules/project/project.module';
import { ProductAnalogModule } from './modules/product-analog/product-analog.module';
import { VoiceModule } from './modules/voice/voice.module';
import { ReferenceModule } from './modules/reference/reference.module';
import { BrandManifestModule } from './modules/brand-manifest/brand-manifest.module';
import { ProjectSessionModule } from './modules/project-session/project-session.module';
import { YoutubeSearchModule } from './modules/youtube-search/youtube-search.module';
import { CastingModule } from './modules/casting/casting.module';
import { VideoAuditModule } from './modules/video-audit/video-audit.module';
import { PublicationModule } from './modules/publication/publication.module';
import { ReferenceAssetsModule } from './modules/reference-assets/reference-assets.module';
import { RelevanceModule } from './modules/relevance/relevance.module';
import { LibraryModule } from './modules/library/library.module';
import { LegalModule } from './modules/legal/legal.module';
import { HealthModule } from './modules/health/health.module';
import { PlanModule } from './modules/plan/plan.module';
import { AiUsageModule } from './modules/ai-usage/ai-usage.module';
import { ImageSketchModule } from './modules/image-sketch/image-sketch.module';
import { PostProductionModule } from './modules/postprod/postprod.module';
import { TtsModule } from './modules/tts/tts.module';
import { NotifyModule } from './modules/notify/notify.module';
import { BlogModule } from './modules/blog/blog.module';
import { SharedVideoModule } from './modules/shared-video/shared-video.module';
import { PublishingChannelModule } from './modules/publishing-channel/publishing-channel.module';
import { PublishingModule } from './modules/publishing/publishing.module';
import { CreditLedgerModule } from './modules/credit-ledger/credit-ledger.module';
import { RenderAccessModule } from './modules/render-access/render-access.module';
import { InviteModule } from './modules/invite/invite.module';
import { TelegramStarsModule } from './modules/billing/telegram-stars.module';
import { BillingModule } from './modules/billing/billing.module';
import { BillingRenewalModule } from './modules/billing-renewal/billing-renewal.module';
import { MarketingModule } from './modules/marketing/marketing.module';
import { CatalogBatchModule } from './modules/catalog-batch/catalog-batch.module';
import { AbTestModule } from './modules/ab-test/ab-test.module';
import { ExportModule } from './modules/export/export.module';
import { ProductFeedImportModule } from './modules/product-feed-import/product-feed-import.module';
import { ActorsModule } from './modules/actors/actors.module';
import { VirtualStudioModule } from './modules/virtual-studio/virtual-studio.module';
import { UserVoicesModule } from './modules/user-voices/user-voices.module';
import { AssistantModule } from './modules/assistant/assistant.module';
import { TutorialScenarioModule } from './modules/tutorial-scenario/tutorial-scenario.module';
import { ClientSiteTutorialModule } from './modules/client-site-tutorial/client-site-tutorial.module';
// Четвёртый тип проекта — ролик-поздравление (ТЗ
// TZ-Greeting-Video-Project-Type.md).
import { GreetingBriefModule } from './modules/greeting-brief/greeting-brief.module';
import { WizardGuideModule } from './modules/wizard-guide/wizard-guide.module';
import { GreetingPromptModule } from './modules/greeting-prompt/greeting-prompt.module';
import { GreetingVideoModule } from './modules/greeting-video/greeting-video.module';
import { GreetingReferenceModule } from './modules/greeting-reference/greeting-reference.module';
import { GreetingVoiceModule } from './modules/greeting-voice/greeting-voice.module';
import { GreetingMusicModule } from './modules/greeting-music/greeting-music.module';
import { GreetingCardsModule } from './modules/greeting-cards/greeting-cards.module';
import { GreetingStickerModule } from './modules/greeting-sticker/greeting-sticker.module';
import { GreetingScenesModule } from './modules/greeting-scenes/greeting-scenes.module';
// Маркетплейс исполнителей — Этап 0 / Фаза 1 (ТЗ на маркетплейс §19–§21,
// ТЗ на бэкенд §6). Tender/Contract/Escrow сознательно не подключены —
// они не существуют в коде, пока не появится сигнал спроса (§19.4).
import { CreatorProfileModule } from './modules/creator-profile/creator-profile.module';
import { PortfolioModule } from './modules/portfolio/portfolio.module';
import { CreatorInquiryModule } from './modules/creator-inquiry/creator-inquiry.module';
import { AuctionModule } from './modules/auction/auction.module';
import { SessionService } from './common/session.service';
import { APP_GUARD } from '@nestjs/core';
import { SessionOwnerGuard } from './modules/telegram-auth/session-owner.guard';

@Global()
@Module({
  imports: [
    PrismaModule,
    StorageModule,
    VideoModule,
    AnalysisModule,
    SessionsModule,
    ProductModule,
    PromptModule,
    GenerationModule,
    CronModule,
    TelegramAuthModule,
    AdminAuthModule,
    AdminPanelModule,
    TelegramLoginModule,
    ProjectModule,
    ProductAnalogModule,
    VoiceModule,
    ReferenceModule,
    BrandManifestModule,
    ProjectSessionModule,
    YoutubeSearchModule,
    CastingModule,
    VideoAuditModule,
    PublicationModule,
    ReferenceAssetsModule,
    RelevanceModule,
    LibraryModule,
    LegalModule,
    HealthModule,
    PlanModule,
    AiUsageModule,
    ImageSketchModule,
    TtsModule,
    PostProductionModule,
    NotifyModule,
    BlogModule,
    SharedVideoModule,
    PublishingChannelModule,
    PublishingModule,
    CreditLedgerModule,
    // Граница бесплатного: право на рендер (этап 132) и кабинет с тем,
    // чем оно открывается (этап 133).
    RenderAccessModule,
    InviteModule,
    TelegramStarsModule,
    BillingModule,
    BillingRenewalModule,
    MarketingModule,
    CatalogBatchModule,
    AbTestModule,
    ProductFeedImportModule,
    ActorsModule,
    VirtualStudioModule,
    UserVoicesModule,
    ExportModule,
    AssistantModule,
    TutorialScenarioModule,
    ClientSiteTutorialModule,
    GreetingBriefModule,
    WizardGuideModule,
    GreetingPromptModule,
    GreetingVideoModule,
    GreetingReferenceModule,
    GreetingVoiceModule,
    GreetingMusicModule,
    GreetingCardsModule,
    GreetingStickerModule,
    GreetingScenesModule,
    CreatorProfileModule,
    PortfolioModule,
    CreatorInquiryModule,
    AuctionModule,
  ],
  providers: [
    SessionService,
    // Б-3.4: сессия с владельцем принадлежит только ему. Глобально,
    // потому что маршрутов с `:sessionId` тринадцать в одиннадцати
    // контроллерах — правило, размазанное по ним, разъедется на первом
    // же новом маршруте. Гвард ничего не делает, когда `sessionId` в
    // запросе нет; см. `session-owner.guard.ts`.
    { provide: APP_GUARD, useClass: SessionOwnerGuard },
  ],
  exports: [SessionService],
})
export class AppModule implements NestModule {
  /**
   * TelegramIdentityMiddleware runs on every route (including /admin/*
   * — harmless there, it only ever sets req.telegramUserId and never
   * blocks; the admin routes use their own, separate AdminSessionGuard
   * for actual authorization, see modules/admin-auth). Registered here
   * rather than in main.ts's app.use() so it stays a proper Nest
   * provider with PrismaService injected via DI, consistent with the
   * rest of the app.
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TelegramIdentityMiddleware).forRoutes('*');
  }
}
