import { Module } from '@nestjs/common';
import { AdminAuthModule } from '../admin-auth/admin-auth.module';
import { AdminPanelModule } from '../admin-panel/admin-panel.module';
import { BillingModule } from '../billing/billing.module';
import { StorageModule } from '../storage/storage.module';
import { AiUsageModule } from '../ai-usage/ai-usage.module';
import { GeminiFilesService } from '../analysis/gemini-files.service';
import { AuctionPaymentModule } from './auction-payment.module';
import { AuctionAiAssessmentService } from './auction-ai-assessment.service';
import {
  AuctionController,
  PublicAuctionController,
  AdminAuctionController,
} from './auction.controller';
import { AuctionService } from './auction.service';
import { GoogleAdsService } from './google-ads.service';
import { GoogleIndexingService } from './google-indexing.service';
import { LiveAuctionOrchestratorService } from './live-auction-orchestrator.service';

/**
 * AuctionModule — ТЗ на маркетплейс §22, Этапы 2–3, и живой аукцион
 * (docs-tz/TZ-Virtualnaya-Studiya-i-AI-Vedushaya.md §7, Этап 5). Порядок
 * контроллеров важен: AuctionController (со статичными /auctions/mine,
 * /auctions/my-bids) регистрируется раньше PublicAuctionController (с
 * динамичным /auctions/:id) — тот же приём, что уже есть в
 * PortfolioModule. Новые /auctions/:id/state и /auctions/:id/stream
 * (PublicAuctionController) этого порядка не касаются — лишний
 * статичный сегмент после :id делает их однозначно отличимыми от
 * /auctions/:id по числу сегментов пути (Express их не перепутает
 * независимо от порядка регистрации), в отличие от /auctions/mine,
 * которому конфликт по числу сегментов с /auctions/:id как раз грозит.
 *
 * BillingModule — за self-serve чек-аут (WayForPay, startCheckout).
 * AuctionPaymentModule — НЕ дублирует BillingModule: узкий сервис
 * завершения оплаты, который BillingModule тоже импортирует для своего
 * вебхука — см. доккомментарий AuctionPaymentService.
 * GeminiFilesService — заведён здесь заново, а не импортирован из
 * AnalysisModule (она его не экспортирует) — тот же приём, что уже
 * применён в video-audit.module.ts/actors.module.ts.
 * StorageModule/AiUsageModule — за BlobService/AiUsageService для
 * LiveAuctionOrchestratorService (§7.4), тот же приём, что у
 * VirtualStudioModule. TtsProviderResolverService — не импортируется
 * явно: TtsModule @Global() (см. tts.module.ts), доступен без импорта.
 */
@Module({
  imports: [
    AdminAuthModule,
    AdminPanelModule,
    BillingModule,
    AuctionPaymentModule,
    StorageModule,
    AiUsageModule,
  ],
  controllers: [
    AuctionController,
    PublicAuctionController,
    AdminAuctionController,
  ],
  providers: [
    AuctionService,
    GeminiFilesService,
    AuctionAiAssessmentService,
    GoogleAdsService,
    GoogleIndexingService,
    LiveAuctionOrchestratorService,
  ],
  exports: [
    AuctionService,
    AuctionAiAssessmentService,
    LiveAuctionOrchestratorService,
  ],
})
export class AuctionModule {}
