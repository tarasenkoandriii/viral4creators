/**
 * Цели, атрибуция, статистика, экспорт, интеграции (Э3, агент A; контракт
 * /tmp/k/CONTRACT-E3.md). Публичный приём целей и счётчиков — public/
 * (только AssistPublicDb); свёртки и кроны — system/, cron/; вебхук s2s —
 * основная роль (секрет). Режим «Сайт» (правило графа site↛admin).
 */
import { Module } from '@nestjs/common';
import { AssistKnowledgeCoreModule } from '../assist-knowledge-core/assist-knowledge-core.module';
import { AssistSiteLearningModule } from '../assist-site-learning/assist-site-learning.module';
import { SiteCoreModule } from '../site-core/site-core.module';
import { AnalyticsSettingsService } from './analytics-settings.service';
import { AnalyticsController } from './analytics.controller';
import { AssistAnalyticsCronController } from './cron/analytics-cron.controller';
import { ExportStorage } from './export-storage';
import { ExportsService } from './exports.service';
import { GoalWebhookController } from './goal-webhook.controller';
import { GoalWebhookService } from './goal-webhook.service';
import { GoalsService } from './goals.service';
import { IntegrationsService } from './integrations.service';
import { EventCounts } from './public/event-counts.service';
import { GoalIntake } from './public/goal-intake.service';
import { StatsService } from './stats.service';
import { AnalyticsRollup } from './system/analytics-rollup.service';

@Module({
  imports: [
    SiteCoreModule,
    AssistKnowledgeCoreModule,
    AssistSiteLearningModule,
  ],
  controllers: [
    AnalyticsController,
    GoalWebhookController,
    AssistAnalyticsCronController,
  ],
  providers: [
    GoalIntake,
    EventCounts,
    GoalsService,
    IntegrationsService,
    GoalWebhookService,
    StatsService,
    ExportsService,
    ExportStorage,
    AnalyticsRollup,
    AnalyticsSettingsService,
  ],
  exports: [
    GoalIntake,
    EventCounts,
    IntegrationsService,
    StatsService,
    AnalyticsRollup,
  ],
})
export class AssistAnalyticsModule {}
