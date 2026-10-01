/**
 * Знания режима «Сайт» (ТЗ §4.2, §4.3-бис): только таблицы assist_site_*
 * (+ общая строка assist_sites), поиск по ним, маршруты, крон обхода и
 * индексации. НЕ импортирует assist-admin-* (правила графа site↛admin,
 * site-names↛admin). Владельцы файлов — контракт Э1 §«Файлы».
 */
import { Module } from '@nestjs/common';
import { AssistKnowledgeCoreModule } from '../assist-knowledge-core/assist-knowledge-core.module';
import { SiteCoreModule } from '../site-core/site-core.module';
import { SiteCrawlModule } from '../site-crawl/site-crawl.module';
import { AssistCrawlScheduler } from './crawl-scheduler.service';
import { AssistCrawlRunController } from './cron/assist-crawl-run.controller';
import { AssistEmbedRunController } from './cron/assist-embed-run.controller';
import { SiteKnowledgeNotifier } from './held-notifier';
import { SiteIndexingService } from './site-indexing.service';
import { SiteKnowledgeController } from './site-knowledge.controller';
import { SiteKnowledgeService } from './site-knowledge.service';
import { SiteLearningController } from './site-learning.controller';
import { SiteSourcesService } from './site-sources.service';
import { SiteWizardController } from './wizard/site-wizard.controller';
import { SiteWizardService } from './wizard/site-wizard.service';

@Module({
  imports: [SiteCoreModule, SiteCrawlModule, AssistKnowledgeCoreModule],
  controllers: [
    SiteKnowledgeController,
    SiteLearningController,
    AssistCrawlRunController,
    AssistEmbedRunController,
    // Э2 (W5): мастер «Научите помощника» и полнота знаний.
    SiteWizardController,
  ],
  providers: [
    SiteKnowledgeService,
    SiteIndexingService,
    SiteSourcesService,
    SiteKnowledgeNotifier,
    AssistCrawlScheduler,
    SiteWizardService,
  ],
  exports: [SiteKnowledgeService, AssistCrawlScheduler],
})
export class AssistSiteKnowledgeModule {}
