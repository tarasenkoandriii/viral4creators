import { Module } from '@nestjs/common';
import { SiteCrawlModule } from '../../site-crawl/site-crawl.module';
import { PublisherCoreModule } from '../core/publisher-core.module';
import { CONTENT_PORT } from '../core/ports';
import {
  ApprovalsExpirePublishJob,
  ApprovalsPublishService,
} from './approvals-publish.service';
import { BrandService } from './brand.service';
import { BriefsService } from './briefs.service';
import { ContentCascades } from './cascades';
import { ClaimsService } from './claims.service';
import { ContentMaterialsController } from './content-materials.controller';
import { ContentPortImpl } from './content-port';
import { ContentSourcesController } from './content-sources.controller';
import { ContentsService } from './contents.service';
import { ContentsMemberReassign } from './member-reassign';
import { QaChecksService } from './qa-checks.service';
import { QuestionsService } from './questions.service';
import { RevocationService } from './revocation.service';
import { SourcesService } from './sources.service';

/**
 * AI Publisher — модуль зоны P-B1 (проектный документ §2, §16.3): контент
 * F01–F04, F06 ручным путём — источники (импорт URL через `site-crawl`),
 * вопросы, бренд и оффер, брифы, материалы и версии, claims, QA,
 * согласование hash, `ContentPort` для публикаций P-C, задание
 * `approvals-expire-publish` и вклад `member-reassign:contents`.
 * Публичное чтение опубликованного — `public/content-public.module.ts`.
 */
@Module({
  imports: [PublisherCoreModule, SiteCrawlModule],
  controllers: [ContentSourcesController, ContentMaterialsController],
  providers: [
    ContentCascades,
    SourcesService,
    RevocationService,
    QuestionsService,
    BrandService,
    BriefsService,
    ContentsService,
    ClaimsService,
    QaChecksService,
    ApprovalsPublishService,
    ContentPortImpl,
    ApprovalsExpirePublishJob,
    ContentsMemberReassign,
    { provide: CONTENT_PORT, useExisting: ContentPortImpl },
  ],
  // SourcesService — пакету P-R (первоисточники правил и выдержки тредов
  // Reddit пишутся в pub_sources только сервисом P-B1, §1 reddit-manual-mvp).
  exports: [CONTENT_PORT, ContentsService, SourcesService],
})
export class PublisherContentModule {}
