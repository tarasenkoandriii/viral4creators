/**
 * Цели, атрибуция, статистика, экспорт, интеграции (Э3, агент A; контракт
 * /tmp/k/CONTRACT-E3.md). Публичный приём целей и счётчиков — public/
 * (только AssistPublicDb); свёртки и кроны — system/, cron/; вебхук s2s —
 * основная роль (секрет). Режим «Сайт» (правило графа site↛admin).
 */
import { Module } from '@nestjs/common';
import { AssistV1IpLimit } from '../../common/assist-v1-ip-limit';
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
// Э6-бис (г): монитор голосового управления Т-4 — без своего крона (Vercel
// Hobby): проход зовёт этот же `assist-analytics-run`. Сервис ходит только
// SitesDb/PrismaService (глобальные) — импорта модуля голосового управления
// не нужно (он импортирует чат, а чат — этот модуль: был бы цикл).
import { VoiceMonitorService } from '../assist-site-voice-control/system/voice-monitor.service';
// Э3-бис: аналитика с ИИ — разметка, lead score, выводы, эксперименты,
// согласие, поведение (без новых кронов: AiAnalyticsRunner в кронах выше).
import { SiteAiModule } from '../site-ai/site-ai.module';
import { AiAnalyticsController } from './ai-analytics.controller';
import { AiCabinetService } from './ai/ai-cabinet.service';
import { AiAnalyticsRunner } from './ai/ai-runner.service';
import { AnalyticsBudget } from './ai/analytics-budget';
import { WeeklyInsights } from './ai/insights.service';
import { ConversationLabeler } from './ai/labeler.service';
import { BehaviorRollup } from './behavior/behavior-rollup.service';
import { ExperimentsService } from './exp/experiments.service';
import { AiIntake } from './public/ai-intake.service';

@Module({
  imports: [
    SiteCoreModule,
    AssistKnowledgeCoreModule,
    AssistSiteLearningModule,
    SiteAiModule,
  ],
  controllers: [
    AnalyticsController,
    GoalWebhookController,
    AssistAnalyticsCronController,
    AiAnalyticsController,
  ],
  providers: [
    GoalIntake,
    EventCounts,
    GoalsService,
    IntegrationsService,
    GoalWebhookService,
    AssistV1IpLimit,
    StatsService,
    ExportsService,
    ExportStorage,
    AnalyticsRollup,
    AnalyticsSettingsService,
    VoiceMonitorService,
    AnalyticsBudget,
    ConversationLabeler,
    WeeklyInsights,
    ExperimentsService,
    BehaviorRollup,
    AiAnalyticsRunner,
    AiCabinetService,
    AiIntake,
  ],
  exports: [
    AiIntake,
    GoalIntake,
    EventCounts,
    IntegrationsService,
    StatsService,
    AnalyticsRollup,
  ],
})
export class AssistAnalyticsModule {}
