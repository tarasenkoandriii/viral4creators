import { Module } from '@nestjs/common';
import { PublisherAiModule } from '../ai/ai.module';
import { PublisherContentModule } from '../content/content.module';
import { PublisherCoreModule } from '../core/publisher-core.module';
import { REDDIT_PORT } from '../core/ports';
import { PublisherDistributionModule } from '../distribution/distribution.module';
import { RedditBriefsService } from './briefs.service';
import { RedditCommunitiesService } from './communities.service';
import { RedditGenerateService } from './generate.service';
import { RedditHandoffService } from './handoff.service';
import { RedditOpportunitiesService } from './opportunities.service';
import { RedditProjectsService } from './projects.service';
import { PublisherRedditController } from './reddit.controller';
import { RedditEnabledGuard } from './reddit-flag.guard';
import { RedditPortImpl } from './reddit-port';
import { RedditRetentionJob } from './retention.job';
import { AdminRedditController } from './admin/admin-reddit.controller';
import { AdminRedditService } from './admin/admin-reddit.service';
import {
  AdminAccessLog,
  AdminAccessLogRetentionJob,
} from './admin/admin-access-log';

/**
 * AI Publisher — зона P-R «Reddit Manual MVP» (doc/ai-publisher/
 * reddit-manual-mvp-adapted.md §2–§4): M1 Research — проекты, сообщества
 * (с каналом `community` через `ChannelsService` P-C), реестр правил и
 * Policy Gate, ключевые запросы, возможности со score v1; M2 AI Content
 * Studio — Reddit-брифы, генерация `pub.reddit.draft` (шлюз P-B2),
 * материалы и проверка `reddit_policy` (записи — P-B1 через
 * `RedditMaterialsService`, правила — порт `REDDIT_PORT` отсюда),
 * копирование, отчёт о ручной публикации (`PublicationsService` P-C),
 * задание `reddit-retention`.
 *
 * Пишет только `pub_reddit_*`; источники, материалы, QA, публикации — через
 * сервисы пакетов-владельцев. Сети нет (Р-RD-0): модуль не импортирует
 * `site-crawl` и сетевые клиенты (правило графа `publisher-reddit-no-network`);
 * модель вызывает только шлюз P-B2. Выключен флагом `PUBLISHER_REDDIT_ENABLED`
 * (404 на всех маршрутах); генерация — ещё и `PUBLISHER_REDDIT_AI_ENABLED`.
 */
@Module({
  imports: [
    PublisherCoreModule,
    PublisherContentModule,
    PublisherDistributionModule,
    PublisherAiModule,
  ],
  // P-R-ADM: внутренний API вкладки «Reddit» Админки (`admin/`).
  controllers: [PublisherRedditController, AdminRedditController],
  providers: [
    RedditEnabledGuard,
    RedditProjectsService,
    RedditCommunitiesService,
    RedditOpportunitiesService,
    RedditBriefsService,
    RedditGenerateService,
    RedditHandoffService,
    RedditPortImpl,
    { provide: REDDIT_PORT, useExisting: RedditPortImpl },
    RedditRetentionJob,
    AdminRedditService,
    AdminAccessLog,
    AdminAccessLogRetentionJob,
  ],
})
export class PublisherRedditModule {}
