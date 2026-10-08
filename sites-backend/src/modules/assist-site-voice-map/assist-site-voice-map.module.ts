/**
 * Голосовая карта «Сайта» — визуальный редактор голосового управления
 * (Э6-тер, ТЗ помощника §5-кватер). Кабинет TMA (`voice-map.controller`) и
 * панель редактора в iframe `we.` (`editor/`) — основная роль; публичный
 * код плана читает только представление опубликованной версии
 * (`assist-site-voice-control/public/voice-map-store.ts`, assist_public).
 * Чистое ядро — `assist-ui-core/voice-map.ts` (без базы). Мемо в редакторе
 * (запись кликами, «Прогнать», Э6-тер (д)) — `editor/editor-memo.*` поверх
 * кабинета мемо (`MemoService`). «Админка» — своим
 * модулем после Э6-бис (б) (К-9).
 */
import { Module } from '@nestjs/common';
import { BrowserJobsModule } from '../browser-jobs/browser-jobs.module';
import { SiteSonioxStt } from '../assist-site-voice/public/soniox-stt.client';
import { SiteAiModule } from '../site-ai/site-ai.module';
import { MemoService } from '../assist-site-voice-control/cabinet/memo.service';
import { SiteCoreModule } from '../site-core/site-core.module';
import { EditorMemoController } from './editor/editor-memo.controller';
import { EditorMemoService } from './editor/editor-memo.service';
import { EditorFrameController } from './editor/editor-frame.controller';
import { EditorController } from './editor/editor.controller';
import { EditorSessionService } from './editor/editor-session.service';
import { EditorVoiceController } from './editor/editor-voice.controller';
import { EditorVoiceService } from './editor/editor-voice.service';
import { DevReportController } from './dev-report.controller';
import { DevReportService } from './dev-report.service';
import { MapMissesService } from './map-misses';
import { VoiceMapToolsController } from './voice-map-tools.controller';
import { VoiceMapController } from './voice-map.controller';
import { VoiceMapWorkerController } from './voice-map-worker.controller';
import { VoiceMapWorkerService } from './voice-map-worker.service';
import { VoiceMapService } from './voice-map.service';

@Module({
  imports: [SiteCoreModule, BrowserJobsModule, SiteAiModule],
  controllers: [
    VoiceMapController,
    VoiceMapWorkerController,
    // Заход 9: отчёт для разработчика (ссылка), промахи Т-4 по целям.
    VoiceMapToolsController,
    DevReportController,
    EditorController,
    EditorMemoController,
    // Заход 9: микрофон «Сказать сейчас» в панели.
    EditorVoiceController,
    EditorFrameController,
  ],
  providers: [
    VoiceMapService,
    VoiceMapWorkerService,
    EditorSessionService,
    // Э6-тер (д): мемо в редакторе — черновик пишет кабинет мемо (основная
    // роль, без состояния; свой экземпляр, модуль голосового управления не
    // тянем — у него публичная зона и модель).
    MemoService,
    EditorMemoService,
    DevReportService,
    MapMissesService,
    // Распознавание — тот же клиент Soniox, что у виджета (без состояния).
    SiteSonioxStt,
    EditorVoiceService,
  ],
  exports: [VoiceMapService],
})
export class AssistSiteVoiceMapModule {}
