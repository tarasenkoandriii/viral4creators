/**
 * Очередь браузерного воркера (Э-С Ш3). Нейтральный модуль: продукты
 * (обход «Админки», «Снимок» и сверка голосовой карты, кадры обучалки)
 * импортируют его, чтобы ставить задания и регистрировать обработчик
 * результата; сам он продукты не импортирует (правило графа
 * `browser-jobs-neutral`). Канал воркера — модуль `internal-worker`.
 */
import { Module } from '@nestjs/common';
import { BrowserArtifactStorage } from './artifact-storage';
import { BrowserJobsRetentionController } from './browser-jobs-retention.controller';
import { BrowserJobsService } from './browser-jobs.service';
import { BrowserJobHandlers } from './job-handlers';

@Module({
  controllers: [BrowserJobsRetentionController],
  providers: [BrowserJobsService, BrowserArtifactStorage, BrowserJobHandlers],
  exports: [BrowserJobsService, BrowserJobHandlers],
})
export class BrowserJobsModule {}
