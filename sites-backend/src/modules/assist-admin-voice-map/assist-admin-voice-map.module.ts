/**
 * Голосовая карта «Админки» — заход 11 (№117; ТЗ помощника §5-кватер.9
 * «Изоляция», §5-кватер.13; К-9, В-55): второй экземпляр карты Э6-тер.
 * Кабинет TMA (`…/admin-mode/voice-map/*`, только assistAdmin: owner, Pro),
 * панель редактора на origin «Админки» (`/assist-admin/v1/editor/*`,
 * `/wa/v1/editor-frame`), опубликованная карта для плана сотрудника
 * (`admin-voice-map-store.ts`, читает `AdminUiPlanService`). Только таблицы
 * `assist_admin_*` и нейтральное ядро (`assist-ui-core`); модули «Сайта» не
 * импортирует (граф admin↛site).
 */
import { Module } from '@nestjs/common';
import { AssistAdminChatModule } from '../assist-admin-chat/assist-admin-chat.module';
import { AssistAdminModeModule } from '../assist-admin-mode/assist-admin-mode.module';
import { SiteCoreModule } from '../site-core/site-core.module';
import { AdminVoiceMapController } from './admin-voice-map.controller';
import { AdminVoiceMapService } from './admin-voice-map.service';
import { AdminEditorFrameController } from './editor/admin-editor-frame.controller';
import { AdminEditorSessionService } from './editor/admin-editor-session.service';
import { AdminEditorController } from './editor/admin-editor.controller';

@Module({
  imports: [SiteCoreModule, AssistAdminModeModule, AssistAdminChatModule],
  controllers: [
    AdminVoiceMapController,
    AdminEditorController,
    AdminEditorFrameController,
  ],
  providers: [AdminVoiceMapService, AdminEditorSessionService],
  exports: [AdminVoiceMapService],
})
export class AssistAdminVoiceMapModule {}
