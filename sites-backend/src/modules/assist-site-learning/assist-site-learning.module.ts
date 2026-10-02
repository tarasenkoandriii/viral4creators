/**
 * Обучение на диалогах «Сайта» (Э3, агент L; контракт /tmp/k/CONTRACT-E3.md):
 * сигналы из публичного кода (public/, только AssistPublicDb), очередь и
 * кластеры, проверенные ответы поверх FAQ Э1, кейсы eval из исправлений,
 * качество и симуляция, суточный разбор (system/, cron/). Режим «Сайт».
 */
import { Module } from '@nestjs/common';
import { AssistKnowledgeCoreModule } from '../assist-knowledge-core/assist-knowledge-core.module';
import { AssistSiteKnowledgeModule } from '../assist-site-knowledge/assist-site-knowledge.module';
import { SiteAiModule } from '../site-ai/site-ai.module';
import { SiteCoreModule } from '../site-core/site-core.module';
import { SiteCrawlModule } from '../site-crawl/site-crawl.module';
import { AssistLearnRollupController } from './cron/assist-learn-rollup.controller';
import { GoldenAnswersService } from './golden.service';
import { SiteLearningQueueController } from './learning.controller';
import {
  LearningCandidates,
  LearningQueueService,
} from './learning-queue.service';
import { LearningReadApi } from './learning-read.service';
import { ForgetJobs } from './public/forget-jobs';
import { LearningSignals } from './public/learning-signals';
import { LearningQualityService } from './quality.service';
import { LearnRollup } from './system/learn-rollup.service';

@Module({
  imports: [
    SiteCoreModule,
    SiteAiModule,
    AssistKnowledgeCoreModule,
    AssistSiteKnowledgeModule,
    // L: проверенные ответы идут через ModeKnowledgeCore (FAQ Э1), которому
    // нужны fetcher/обход url-источников — сами FAQ-методы их не зовут.
    SiteCrawlModule,
  ],
  controllers: [SiteLearningQueueController, AssistLearnRollupController],
  providers: [
    LearningSignals,
    ForgetJobs,
    LearningQueueService,
    LearningCandidates,
    GoldenAnswersService,
    LearningQualityService,
    LearningReadApi,
    LearnRollup,
  ],
  exports: [
    // H: кандидат из бота, закрытие передачи, хвост forget в своём кроне.
    LearningSignals,
    ForgetJobs,
    LearningCandidates,
    LearningReadApi,
    LearnRollup,
  ],
})
export class AssistSiteLearningModule {}
