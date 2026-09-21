import { Module } from '@nestjs/common';
import { AdminAuthModule } from '../admin-auth/admin-auth.module';
import { AdminPanelModule } from '../admin-panel/admin-panel.module';
import { StorageModule } from '../storage/storage.module';
import {
  AdminPortfolioController,
  PortfolioController,
  PortfolioLikeController,
  PublicPortfolioController,
} from './portfolio.controller';
import { PortfolioService } from './portfolio.service';
import { PortfolioWatermarkService } from './portfolio-watermark.service';

/**
 * PortfolioModule — Этап 0 / Фаза 1 маркетплейса (ТЗ на маркетплейс §9,
 * §11.1; ТЗ на бэкенд §6). Построен на паттерне SharedVideoModule.
 *
 * StorageModule — за BlobService (PortfolioWatermarkService пересохраняет
 * готовый watermark-ffmpeg-результат в своё хранилище, §9/§22, защита
 * от пиратства). FfmpegApiService/AiUsageService сюда не импортируются
 * явно — оба @Global() (postprod/ai-usage), уже доступны везде.
 */
@Module({
  imports: [AdminAuthModule, AdminPanelModule, StorageModule],
  controllers: [
    PortfolioController,
    PublicPortfolioController,
    PortfolioLikeController,
    AdminPortfolioController,
  ],
  providers: [PortfolioService, PortfolioWatermarkService],
  exports: [PortfolioService, PortfolioWatermarkService],
})
export class PortfolioModule {}
