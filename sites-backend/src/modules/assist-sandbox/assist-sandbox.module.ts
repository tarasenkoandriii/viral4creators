/**
 * Песочница (режим «Сайт», правило графа: в SITE_MODE): анонимная с
 * лендинга и онбординг в TMA. Использует обход (site-crawl), ядро знаний
 * и поиск «Сайта» для подтверждённых сайтов. Владелец — K3.
 */
import { Module } from '@nestjs/common';
import { AssistKnowledgeCoreModule } from '../assist-knowledge-core/assist-knowledge-core.module';
import { AssistSiteKnowledgeModule } from '../assist-site-knowledge/assist-site-knowledge.module';
import { SiteCoreModule } from '../site-core/site-core.module';
import { SiteCrawlModule } from '../site-crawl/site-crawl.module';
import { CabinetSandboxController } from './cabinet-sandbox.controller';
import { PublicSandboxController } from './public-sandbox.controller';
import { AssistRetentionController } from './sandbox-retention.controller';
import { SandboxService } from './sandbox.service';

@Module({
  imports: [
    SiteCoreModule,
    SiteCrawlModule,
    AssistKnowledgeCoreModule,
    AssistSiteKnowledgeModule,
  ],
  controllers: [
    PublicSandboxController,
    CabinetSandboxController,
    AssistRetentionController,
  ],
  providers: [SandboxService],
})
export class AssistSandboxModule {}
