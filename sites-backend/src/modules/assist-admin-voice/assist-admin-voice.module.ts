/**
 * Голосовое управление — режим «Админка» (Э6-бис (б), ТЗ помощника
 * §5-бис.1–9, §5-бис.13–15, §5-бис.17 п.10): кабинет переключателя и
 * мастера (только `assistAdmin: owner`), маршруты сотрудника `/assist-admin/
 * v1/voice|ui-plan|voice-test` (сессия employee-JWT, iframe `wa.`). Только
 * таблицы assist_admin_* и нейтральное ядро `assist-ui-core`; модули
 * «Сайта» не импортирует (граф admin↛site), публичный код «Сайта» этот
 * модуль не импортирует (site↛admin).
 */
import { Module } from '@nestjs/common';
import { AssistAdminActionsModule } from '../assist-admin-actions/assist-admin-actions.module';
import { AssistAdminChatModule } from '../assist-admin-chat/assist-admin-chat.module';
import { AssistAdminModeModule } from '../assist-admin-mode/assist-admin-mode.module';
import { SiteAiModule } from '../site-ai/site-ai.module';
import { SiteCoreModule } from '../site-core/site-core.module';
import { AdminSonioxStt } from './admin-stt';
import { AdminUiPlanService } from './admin-ui-plan.service';
import { AdminVoiceController } from './admin-voice.controller';
import { AdminVoiceEmbedController } from './admin-voice-embed.controller';
import { AdminVoiceInputService } from './admin-voice-input.service';
import { AdminVoiceNotifier } from './admin-voice-notifier';
import { AdminVoiceSettingsService } from './admin-voice-settings.service';
import { AdminVoiceTestService } from './admin-voice-test.service';
import { AdminMemoCheckService } from './admin-memo-check.service';

@Module({
  imports: [
    SiteCoreModule,
    SiteAiModule,
    AssistAdminModeModule,
    AssistAdminChatModule,
    AssistAdminActionsModule,
  ],
  controllers: [AdminVoiceController, AdminVoiceEmbedController],
  providers: [
    AdminMemoCheckService,
    AdminSonioxStt,
    AdminUiPlanService,
    AdminVoiceInputService,
    AdminVoiceNotifier,
    AdminVoiceSettingsService,
    AdminVoiceTestService,
  ],
  exports: [AdminUiPlanService, AdminVoiceSettingsService],
})
export class AssistAdminVoiceModule {}
