/**
 * Режим «Админка»: кабинет и коннекторы — Э7 (ТЗ §3.8, §5). Только
 * таблицы assist_admin_* и ядро; модули «Сайта» не импортирует (правила
 * графа admin↛site, admin-names↛site). Сеть — site-crawl/net (IP-pin,
 * SSRF-guard; site-crawl — общий модуль, «Админке» разрешён, Р-19).
 */
import { Module } from '@nestjs/common';
import { SiteCoreModule } from '../site-core/site-core.module';
import { AdminActionLogService } from './action-log.service';
import { AdminModeController } from './admin-mode.controller';
import { AdminModeService } from './admin-mode.service';
import { AdminStatsService } from './admin-stats.service';
import { ConnectorsService } from './connectors.service';

@Module({
  imports: [SiteCoreModule],
  controllers: [AdminModeController],
  providers: [
    AdminModeService,
    ConnectorsService,
    AdminActionLogService,
    AdminStatsService,
  ],
  exports: [AdminModeService, ConnectorsService, AdminActionLogService],
})
export class AssistAdminModeModule {}
