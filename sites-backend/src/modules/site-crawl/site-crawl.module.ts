/**
 * Модуль `site-crawl` — ОБЩИЙ с QA (ТЗ помощника §4.2): обход публичных
 * страниц verified-хостов, sitemap, robots, извлечение текста, хеши,
 * очередь с lease; IP-pin исходящих запросов. Хранит только публичный кэш
 * (`site_pages`). Не импортирует продуктовые модули (правило графа
 * crawl-product-neutral). Владелец кода в Э1 — агент K1.
 */
import { Module } from '@nestjs/common';
import { SiteCoreModule } from '../site-core/site-core.module';
import { SiteCrawlService } from './crawl.service';
import { PublicPageFetcher } from './page-fetcher';
import { RobotsService } from './robots';
import { SitemapService } from './sitemap';

@Module({
  imports: [SiteCoreModule],
  providers: [
    RobotsService,
    SitemapService,
    PublicPageFetcher,
    SiteCrawlService,
  ],
  exports: [RobotsService, SitemapService, PublicPageFetcher, SiteCrawlService],
})
export class SiteCrawlModule {}
