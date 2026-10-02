/**
 * Утренняя сводка и отчёт недели (Э3, агент A). НЕЙТРАЛЬНЫЙ оркестратор:
 * единственный модуль, который видит и «Сайт», и «Админку» — только числа,
 * и раздел «Админка» — только assistAdmin: owner. Правило графа
 * `digest-leaf`: его не импортирует ни один модуль (только app.module).
 */
import { Module } from '@nestjs/common';
import { AssistAdminKnowledgeModule } from '../assist-admin-knowledge/assist-admin-knowledge.module';
import { AssistAnalyticsModule } from '../assist-analytics/assist-analytics.module';
import { AssistSiteLearningModule } from '../assist-site-learning/assist-site-learning.module';
import { SiteCoreModule } from '../site-core/site-core.module';
import { AssistDigestController } from './cron/assist-digest.controller';
import { AssistDigestService } from './digest.service';

@Module({
  imports: [
    SiteCoreModule,
    AssistAnalyticsModule,
    AssistSiteLearningModule,
    AssistAdminKnowledgeModule,
  ],
  controllers: [AssistDigestController],
  providers: [AssistDigestService],
})
export class AssistDigestModule {}
