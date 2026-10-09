/**
 * Аналитика «Админки» (заход 10, №57; ТЗ §5-тер.13, Р-48): разметка
 * диалогов сотрудников, суточная свёртка по ролям, выводы и отчёт недели,
 * выгрузки CSV, push по тревоге компенсаций (Р-З10-13). Только таблицы
 * assist_admin_* и нейтральные модули (site-ai, assist-knowledge-core/notify);
 * модули «Сайта» не импортирует (правила графа admin↛site, admin-names↛site).
 * Исполнение — из крона assist-admin-embed-run (AdminAnalyticsRunner).
 * Заход 11: отчёт недели — разделом утренней сводки (AdminWeeklyDigest).
 */
import { Module } from '@nestjs/common';
import { AssistAdminModeModule } from '../assist-admin-mode/assist-admin-mode.module';
import { SiteAiModule } from '../site-ai/site-ai.module';
import { SiteCoreModule } from '../site-core/site-core.module';
import { AdminCompensationAlerts } from './admin-alerts.service';
import { AdminAnalyticsController } from './admin-analytics.controller';
import { AdminAnalyticsRunner } from './admin-analytics.runner';
import { AdminAnalyticsCabinet } from './admin-analytics.service';
import { AdminExportStorage } from './admin-export-storage';
import { AdminExports } from './admin-exports.service';
import { AdminLabeler } from './admin-labeler.service';
import { AdminRollup } from './admin-rollup.service';
import { AdminWeeklyDigest } from './admin-weekly-digest';
import { AdminWeekly } from './admin-weekly.service';

@Module({
  imports: [SiteCoreModule, SiteAiModule, AssistAdminModeModule],
  controllers: [AdminAnalyticsController],
  providers: [
    AdminAnalyticsCabinet,
    AdminExportStorage,
    AdminExports,
    AdminLabeler,
    AdminRollup,
    AdminWeekly,
    AdminWeeklyDigest,
    AdminCompensationAlerts,
    AdminAnalyticsRunner,
  ],
  // Р-З11-В3: AdminWeeklyDigest — сводке assist-digest (раздел отчёта недели).
  exports: [AdminAnalyticsRunner, AdminWeeklyDigest],
})
export class AssistAdminAnalyticsModule {}
