/**
 * Системный API знаний сайта (Э-С Ш5): документы из кода владельца —
 * в базу знаний режима «Сайт» по ключу интеграции. Режим «Сайт» (правило
 * графа site↛admin): берёт источники «Сайта» и секреты интеграций.
 */
import { Module } from '@nestjs/common';
import { AssistAnalyticsModule } from '../assist-analytics/assist-analytics.module';
import { AssistSiteKnowledgeModule } from '../assist-site-knowledge/assist-site-knowledge.module';
import { KnowledgeApiController } from './knowledge-api.controller';
import { KnowledgeApiService } from './knowledge-api.service';

@Module({
  imports: [AssistSiteKnowledgeModule, AssistAnalyticsModule],
  controllers: [KnowledgeApiController],
  providers: [KnowledgeApiService],
})
export class AssistSiteKnowledgeApiModule {}
