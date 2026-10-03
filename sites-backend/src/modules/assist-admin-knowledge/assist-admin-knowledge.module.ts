/**
 * Знания режима «Админка» (ТЗ §4.3-бис): только таблицы assist_admin_*;
 * из общего — site-crawl (site_pages для копии публичного обхода, Р-19) и
 * нейтральное ядро. НЕ импортирует модули «Сайта» (admin↛site,
 * admin-names↛site). Владельцы файлов — контракт Э1 §«Файлы».
 */
import { Module } from '@nestjs/common';
import { AssistKnowledgeCoreModule } from '../assist-knowledge-core/assist-knowledge-core.module';
import { SiteCoreModule } from '../site-core/site-core.module';
import { SiteCrawlModule } from '../site-crawl/site-crawl.module';
import { AdminDigestSource } from './admin-digest';
import { AdminIndexingService } from './admin-indexing.service';
import { AdminKnowledgeController } from './admin-knowledge.controller';
import { AdminKnowledgeService } from './admin-knowledge.service';
import { AdminLearningController } from './admin-learning.controller';
import { AdminLearningQueueService } from './admin-learning-queue.service';
import { AdminSourcesService } from './admin-sources.service';
import { AssistAdminEmbedRunController } from './cron/assist-admin-embed-run.controller';

@Module({
  imports: [SiteCoreModule, SiteCrawlModule, AssistKnowledgeCoreModule],
  controllers: [
    AdminKnowledgeController,
    AdminLearningController,
    AssistAdminEmbedRunController,
  ],
  providers: [
    AdminKnowledgeService,
    AdminIndexingService,
    AdminSourcesService,
    // Э7: очередь обучения «Админки» (контур (г)).
    AdminLearningQueueService,
    // Э3: факты для утренней сводки/отчёта недели (A, assist-digest).
    AdminDigestSource,
  ],
  exports: [AdminKnowledgeService, AdminDigestSource],
})
export class AssistAdminKnowledgeModule {}
