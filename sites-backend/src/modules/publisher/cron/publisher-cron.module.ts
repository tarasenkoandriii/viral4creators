import { Module } from '@nestjs/common';
import { PublisherCoreModule } from '../core/publisher-core.module';
import { PubCronRegistry } from './job-registry';
import { PublisherCronController } from './publisher-cron.controller';

/**
 * AI Publisher — кроны (P-A1, проектный документ §2, §15.1): контроллер
 * двух путей и реестр заданий. Задания — провайдеры пакетов с
 * `@PubContribution('cron-job')`; реестр находит их через
 * `PubContributions` ядра (`DiscoveryService`), модули пакетов сюда не
 * импортируются.
 */
@Module({
  imports: [PublisherCoreModule],
  controllers: [PublisherCronController],
  providers: [PubCronRegistry],
  exports: [PubCronRegistry],
})
export class PublisherCronModule {}
