/**
 * Голосовая карта «Сайта» — визуальный редактор голосового управления
 * (Э6-тер, ТЗ помощника §5-кватер). Кабинет TMA (`voice-map.controller`) и
 * панель редактора в iframe `we.` (`editor/`) — основная роль; публичный
 * код плана читает только представление опубликованной версии
 * (`assist-site-voice-control/public/voice-map-store.ts`, assist_public).
 * Чистое ядро — `assist-ui-core/voice-map.ts` (без базы). «Админка» — своим
 * модулем после Э6-бис (б) (К-9).
 */
import { Module } from '@nestjs/common';
import { SiteCoreModule } from '../site-core/site-core.module';
import { EditorFrameController } from './editor/editor-frame.controller';
import { EditorController } from './editor/editor.controller';
import { EditorSessionService } from './editor/editor-session.service';
import { VoiceMapController } from './voice-map.controller';
import { VoiceMapService } from './voice-map.service';

@Module({
  imports: [SiteCoreModule],
  controllers: [VoiceMapController, EditorController, EditorFrameController],
  providers: [VoiceMapService, EditorSessionService],
  exports: [VoiceMapService],
})
export class AssistSiteVoiceMapModule {}
