/**
 * Публичный виджет «Сайта» (Э2, W2): /widget/v1/*, HTML iframe, лендинг.
 * Режим «Сайт» (правило графа site↛admin); правило `widget-public-db`:
 * модуль не импортирует SitesDb/PrismaService — только AssistPublicDb
 * (исключение — папка cabinet/: кабинетный маршрут атрибуции под
 * основной ролью). Конвейер ответа — W3 (assist-site-chat).
 */
import { Module } from '@nestjs/common';
import { AssistAnalyticsModule } from '../assist-analytics/assist-analytics.module';
import { AssistSiteChatModule } from '../assist-site-chat/assist-site-chat.module';
import { AssistSiteHandoffModule } from '../assist-site-handoff/assist-site-handoff.module';
import { AssistSiteLearningModule } from '../assist-site-learning/assist-site-learning.module';
import { AssistSiteVoiceModule } from '../assist-site-voice/assist-site-voice.module';
import { SiteCoreModule } from '../site-core/site-core.module';
import { AcquisitionController } from './cabinet/acquisition.controller';
import { AcquisitionService } from './cabinet/acquisition.service';
import { LandingDraftController } from './cabinet/landing-draft.controller';
import { LandingDraftService } from './cabinet/landing-draft.service';
import { WidgetFrameController } from './frame.controller';
import { LandingPublicController } from './landing/landing.controller';
import { LandingService } from './landing/landing.service';
import { WidgetOriginGuard } from './origin-guard';
import { WidgetRateLimit } from './rate-limit';
import { WidgetChatService } from './widget-chat.service';
import { WidgetPublicConfigService } from './widget-config.service';
import { WidgetEngagementController } from './widget-engagement.controller';
import { WidgetEngagementService } from './widget-engagement.service';
import { WidgetPublicController } from './widget-public.controller';
import { WidgetSessionService } from './widget-session.service';
import { WidgetStateService } from './widget-state.service';
import { WidgetVoiceController } from './widget-voice.controller';

@Module({
  imports: [
    SiteCoreModule,
    AssistSiteChatModule,
    // Э3: передача человеку, цели/счётчики, хвост forget (публичные части — public/ модулей).
    AssistSiteHandoffModule,
    AssistAnalyticsModule,
    AssistSiteLearningModule,
    // Э5: голос посетителя (публичная часть — public/ модуля голоса).
    AssistSiteVoiceModule,
  ],
  controllers: [
    WidgetPublicController,
    WidgetEngagementController,
    WidgetVoiceController,
    WidgetFrameController,
    LandingPublicController,
    AcquisitionController,
    LandingDraftController,
  ],
  providers: [
    WidgetOriginGuard,
    WidgetRateLimit,
    WidgetSessionService,
    WidgetStateService,
    WidgetChatService,
    WidgetPublicConfigService,
    WidgetEngagementService,
    LandingService,
    AcquisitionService,
    LandingDraftService,
  ],
})
export class AssistWidgetModule {}
