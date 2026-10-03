/**
 * Голосовое управление интерфейсом, режим «Сайт» (Э6-бис (а), ТЗ помощника
 * §5-бис): план посетителя (`public/` — под assist_public, его зовут
 * маршруты assist-widget `/widget/v1/ui-plan*`) и кабинет переключателя и
 * правил (`cabinet/` — основная роль). (г) Мастер проверки Т-2 —
 * `public/voice-test.service.ts` (тестовая сессия, анализ, отчёт; (е) сухой
 * прогон мемо по страницам); (д) цепочки и возврат — в `public/ui-plan.service.ts`;
 * (е) мемо «Сайта» — кабинет `cabinet/memo.*` (основная роль), исполнение —
 * `public/` через представления; монитор
 * Т-4 — `system/voice-monitor.service.ts` (основная роль; его зовёт крон
 * `assist-analytics-run`, отдельного крона нет). Проверки плана — нейтральный пакет
 * `assist-ui-core` (без базы; его же возьмёт «Админка» в Э6-бис (б)).
 * Правило графа `public-zone-e6b`: публичный код других модулей берёт
 * отсюда только `public/`, типы, `*-config` и модуль.
 */
import { Module } from '@nestjs/common';
import { AssistSiteChatModule } from '../assist-site-chat/assist-site-chat.module';
import { AssistSiteVoiceModule } from '../assist-site-voice/assist-site-voice.module';
import { SiteAiModule } from '../site-ai/site-ai.module';
import { SiteCoreModule } from '../site-core/site-core.module';
import { MemoController } from './cabinet/memo.controller';
import { MemoService } from './cabinet/memo.service';
import { VoiceControlSettingsController } from './cabinet/voice-control-settings.controller';
import { VoiceControlSettingsService } from './cabinet/voice-control-settings.service';
import { SiteUiPlanService } from './public/ui-plan.service';
import { VoiceTestService } from './public/voice-test.service';

@Module({
  imports: [
    SiteCoreModule,
    SiteAiModule,
    AssistSiteChatModule,
    AssistSiteVoiceModule,
  ],
  controllers: [VoiceControlSettingsController, MemoController],
  providers: [
    SiteUiPlanService,
    VoiceTestService,
    VoiceControlSettingsService,
    MemoService,
  ],
  exports: [SiteUiPlanService, VoiceTestService],
})
export class AssistSiteVoiceControlModule {}
