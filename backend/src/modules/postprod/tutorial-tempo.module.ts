import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { ClientSiteMediaModule } from '../client-site-media/client-site-media.module';
import { TutorialVideoVersionsService } from './tutorial-video-versions.service';
import { TutorialVideosController } from './tutorial-videos.controller';

/**
 * Постпродакшен обучалок: темп и покадровая озвучка (06.10.2026).
 *
 * Свой модуль, а не часть `PostProductionModule`: тот глобальный и
 * нужен генерации, а этому нужен ещё и `ClientSiteMediaModule`
 * (обновить набор роликов сайта помощника после активации версии) —
 * тянуть его в глобальный модуль генерации незачем. Подключается
 * раннером обучалки (опрос версий в кроне, уборка) и обучалкой по сайту
 * клиента (озвучка при одобрении) — оттуда же монтируется и контроллер.
 * `FfmpegApiService`, `PlanService`, `AiUsageService` и TTS — глобальные.
 */
@Module({
  imports: [StorageModule, ClientSiteMediaModule],
  controllers: [TutorialVideosController],
  providers: [TutorialVideoVersionsService],
  exports: [TutorialVideoVersionsService],
})
export class TutorialTempoModule {}
