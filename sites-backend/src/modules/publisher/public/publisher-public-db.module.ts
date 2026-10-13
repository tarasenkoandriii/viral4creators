import { Module } from '@nestjs/common';
import { PublisherPublicDb } from '../../../prisma/publisher-public-db.service';

/**
 * AI Publisher (P-A0): клиент роли `publisher_public` для публичного кода
 * (`publisher/public/**`). Импортировать этот модуль — и взять клиент —
 * может только публичная зона Publisher (правило графа
 * `publisher-public-db-zone`); основной ролью публичный код не ходит
 * (`public-db`), клиентом виджета — тоже (`publisher-public-db`).
 */
@Module({
  providers: [PublisherPublicDb],
  exports: [PublisherPublicDb],
})
export class PublisherPublicDbModule {}
