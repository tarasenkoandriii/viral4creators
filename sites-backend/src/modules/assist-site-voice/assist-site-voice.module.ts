/**
 * Голос виджета «Сайта» (Э5): распознавание вопроса и озвучка ответа
 * (`public/` — под assist_public, его зовут маршруты assist-widget), кабинет
 * голоса (`cabinet/` — основная роль). Режим «Сайт» (правило графа
 * site↛admin); правило `public-zone-e5`: публичный код других модулей берёт
 * отсюда только `public/`, типы, `*-config` и модуль.
 */
import { Module } from '@nestjs/common';
import { AssistSiteChatModule } from '../assist-site-chat/assist-site-chat.module';
import { SiteAiModule } from '../site-ai/site-ai.module';
import { SiteCoreModule } from '../site-core/site-core.module';
import { VoiceSettingsController } from './cabinet/voice-settings.controller';
import { VoiceSettingsService } from './cabinet/voice-settings.service';
import { SiteVoiceService } from './public/site-voice.service';
import { SiteSonioxStt } from './public/soniox-stt.client';
import { SiteSonioxTts } from './public/soniox-tts.client';

@Module({
  imports: [SiteCoreModule, SiteAiModule, AssistSiteChatModule],
  controllers: [VoiceSettingsController],
  providers: [
    SiteSonioxStt,
    SiteSonioxTts,
    SiteVoiceService,
    VoiceSettingsService,
  ],
  exports: [SiteVoiceService],
})
export class AssistSiteVoiceModule {}
