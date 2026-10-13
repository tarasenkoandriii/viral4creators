import { Module } from '@nestjs/common';
import { PublisherContentModule } from '../content/content.module';
import { PublisherCoreModule } from '../core/publisher-core.module';
import { PublisherDistributionModule } from '../distribution/distribution.module';
import { RedditCommunitiesService } from './communities.service';
import { RedditOpportunitiesService } from './opportunities.service';
import { RedditProjectsService } from './projects.service';
import { PublisherRedditController } from './reddit.controller';
import { RedditEnabledGuard } from './reddit-flag.guard';

/**
 * AI Publisher — зона P-R «Reddit Manual MVP», этап M1 Research
 * (doc/ai-publisher/reddit-manual-mvp-adapted.md §2): проекты, сообщества
 * (с каналом `community` через `ChannelsService` P-C), реестр правил и
 * Policy Gate, ключевые запросы, возможности со score v1.
 *
 * Пишет только `pub_reddit_*`; первоисточники правил и выдержки тредов —
 * `pub_sources` через `SourcesService` (P-B1), каналы — через
 * `ChannelsService` (P-C). Сети нет (Р-RD-0): модуль не импортирует
 * `site-crawl` и сетевые клиенты (правило графа `publisher-reddit-no-network`).
 * Выключен флагом `PUBLISHER_REDDIT_ENABLED` (404 на всех маршрутах).
 */
@Module({
  imports: [
    PublisherCoreModule,
    PublisherContentModule,
    PublisherDistributionModule,
  ],
  controllers: [PublisherRedditController],
  providers: [
    RedditEnabledGuard,
    RedditProjectsService,
    RedditCommunitiesService,
    RedditOpportunitiesService,
  ],
})
export class PublisherRedditModule {}
