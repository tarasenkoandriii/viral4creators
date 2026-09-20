import { Module } from '@nestjs/common';
import { AdminAuthModule } from '../admin-auth/admin-auth.module';
import { AdminPanelModule } from '../admin-panel/admin-panel.module';
import {
  AdminPortfolioController,
  PortfolioController,
  PortfolioLikeController,
  PublicPortfolioController,
} from './portfolio.controller';
import { PortfolioService } from './portfolio.service';

/**
 * PortfolioModule — Этап 0 / Фаза 1 маркетплейса (ТЗ на маркетплейс §9,
 * §11.1; ТЗ на бэкенд §6). Построен на паттерне SharedVideoModule.
 */
@Module({
  imports: [AdminAuthModule, AdminPanelModule],
  controllers: [
    PortfolioController,
    PublicPortfolioController,
    PortfolioLikeController,
    AdminPortfolioController,
  ],
  providers: [PortfolioService],
  exports: [PortfolioService],
})
export class PortfolioModule {}
