import { Module } from '@nestjs/common';
import { PublisherCoreModule } from './core/publisher-core.module';
import { PublisherStandModule } from './core/stand.module';
import { PublisherCronModule } from './cron/publisher-cron.module';
import { PublisherContentModule } from './content/content.module';
import { PublisherAiModule } from './ai/ai.module';
import { PublisherDistributionModule } from './distribution/distribution.module';
import { PublisherLeadsModule } from './leads/leads.module';
import { PublisherReportsModule } from './reports/reports.module';
import { PublisherRedditModule } from './reddit/reddit.module';
import { PublisherContentPublicModule } from './public/content-public.module';
import { PublisherIntakePublicModule } from './public/intake-public.module';

/**
 * AI Publisher — модуль `publisher` sites-backend (проектный документ
 * doc/ai-publisher/IMPLEMENTATION-DESIGN.md, §2). Создан P-A0 сразу со
 * всеми подмодулями-заготовками, чтобы пакеты правили только свои файлы:
 *
 *   core/        P-A1  продукт↔сайт, роли, гейты, параметры, аудит
 *   cron/        P-A1  /cron/publisher-tick, /cron/publisher-daily
 *   content/     P-B1  F01–F04, F06
 *   ai/          P-B2  шлюз, генераторы, eval
 *   distribution/P-C   F09, F10, F12, бюджет
 *   leads/       P-D   заявки, F11
 *   reports/     P-E   отчёты, F17, бэкап
 *   reddit/      P-R   Reddit Manual MVP (M1; флаг PUBLISHER_REDDIT_ENABLED)
 *   public/      P-B1 (контент) и P-D (приём) — под ролью publisher_public
 *
 * Граница модуля — правила графа `publisher-*`
 * (scripts/check-sites-import-graph.mjs): Publisher берёт из модулей только
 * site-core, site-ai, site-crawl, telegram-auth и два чистых файла
 * assist-knowledge-core, и его не импортирует ни один модуль.
 */
@Module({
  imports: [
    PublisherCoreModule,
    PublisherCronModule,
    PublisherContentModule,
    PublisherAiModule,
    PublisherDistributionModule,
    PublisherLeadsModule,
    PublisherReportsModule,
    PublisherRedditModule,
    PublisherContentPublicModule,
    PublisherIntakePublicModule,
    // Стенд E2E (Р-PUB-Z2-21): вне стенда — пустой модуль без маршрутов.
    PublisherStandModule.forRoot(),
  ],
})
export class PublisherModule {}
