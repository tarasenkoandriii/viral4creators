/**
 * Публичный виджет «Сайта» (Э2, W2): /widget/v1/*, HTML iframe, лендинг.
 * Режим «Сайт» (правило графа site↛admin); правило `widget-public-db`:
 * модуль не импортирует SitesDb/PrismaService — только AssistPublicDb
 * (исключение — папка cabinet/: кабинетный маршрут атрибуции под
 * основной ролью). Конвейер ответа — W3 (assist-site-chat).
 */
import { Module } from '@nestjs/common';
import { AssistSiteChatModule } from '../assist-site-chat/assist-site-chat.module';
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
import { WidgetPublicController } from './widget-public.controller';
import { WidgetSessionService } from './widget-session.service';
import { WidgetStateService } from './widget-state.service';

@Module({
  imports: [SiteCoreModule, AssistSiteChatModule],
  controllers: [
    WidgetPublicController,
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
    LandingService,
    AcquisitionService,
    LandingDraftService,
  ],
})
export class AssistWidgetModule {}
