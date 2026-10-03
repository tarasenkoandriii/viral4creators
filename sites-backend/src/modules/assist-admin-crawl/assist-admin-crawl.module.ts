/**
 * Обход админки за логином (Э7, ТЗ §5.3): opt-in, задания для браузерного
 * воркера Ш3. Единственный модуль «Админки», которому граф разрешает
 * `site-credentials` (реестр тестовых учёток Ш2 — чтение без секретов).
 */
import { Module } from '@nestjs/common';
import { SiteCoreModule } from '../site-core/site-core.module';
import { SiteCredentialsModule } from '../site-credentials/site-credentials.module';
import { AdminCrawlController } from './admin-crawl.controller';
import { AdminCrawlService } from './admin-crawl.service';

@Module({
  imports: [SiteCoreModule, SiteCredentialsModule],
  controllers: [AdminCrawlController],
  providers: [AdminCrawlService],
})
export class AssistAdminCrawlModule {}
