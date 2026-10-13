import { Module } from '@nestjs/common';
import { PublisherContentPublicController } from './content-public.controller';
import { ContentPublicRepo } from './content-public.repo';
import { PublicProductResolver } from './public-guard';
import { PublisherPublicDbModule } from './publisher-public-db.module';

/**
 * AI Publisher — публичный модуль зоны P-B1 (проектный документ §11.4):
 * чтение опубликованного контента (`GET /public/publisher/v1/contents*`).
 * Клиент БД — только `PublisherPublicDb` (роль `publisher_public`, сырой
 * SQL с явными колонками представлений `pub_public_products`/
 * `pub_public_contents`).
 */
@Module({
  imports: [PublisherPublicDbModule],
  controllers: [PublisherContentPublicController],
  // Резолвер ключа — общий с приёмом P-D (`public-guard.ts`, Р-PUB-Z1-7).
  providers: [ContentPublicRepo, PublicProductResolver],
})
export class PublisherContentPublicModule {}
