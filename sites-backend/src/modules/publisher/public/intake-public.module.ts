import { Module } from '@nestjs/common';
import { EventIntakeService } from './event-intake';
import { PublisherIntakeController } from './intake-public.controller';
import { LeadIntakeService } from './lead-intake';
import { PublicProductResolver } from './public-guard';
import { PublisherPublicDbModule } from './publisher-public-db.module';
import { SiteConfigService } from './site-config';

/**
 * AI Publisher — публичный приём зоны P-D (проектный документ §11.4):
 * `GET /site-config`, `POST /leads`, `POST /events` под ролью
 * `publisher_public` (клиент — только `PublisherPublicDb`, сырой SQL с
 * явными колонками). Резолвер продукта по ключу экспортируется: его может
 * взять публичное чтение контента P-B1.
 */
@Module({
  imports: [PublisherPublicDbModule],
  controllers: [PublisherIntakeController],
  providers: [
    PublicProductResolver,
    SiteConfigService,
    LeadIntakeService,
    EventIntakeService,
  ],
  exports: [PublicProductResolver],
})
export class PublisherIntakePublicModule {}
