/**
 * Обход админки за логином (Э7, ТЗ §5.3): opt-in, задания браузерному
 * воркеру Ш3 (очередь `browser-jobs`). Единственный модуль «Админки»,
 * которому граф разрешает `site-credentials` (реестр тестовых учёток Ш2 —
 * чтение без секретов; аренду берёт канал воркера).
 */
import { Module } from '@nestjs/common';
import { BrowserJobsModule } from '../browser-jobs/browser-jobs.module';
import { SiteCoreModule } from '../site-core/site-core.module';
import { SiteCredentialsModule } from '../site-credentials/site-credentials.module';
import { AdminCrawlController } from './admin-crawl.controller';
import { AdminCrawlService } from './admin-crawl.service';

@Module({
  imports: [SiteCoreModule, SiteCredentialsModule, BrowserJobsModule],
  controllers: [AdminCrawlController],
  providers: [AdminCrawlService],
})
export class AssistAdminCrawlModule {}
