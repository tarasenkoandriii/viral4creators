import { Module } from '@nestjs/common';
import { CreatorInquiryController } from './creator-inquiry.controller';
import { CreatorInquiryService } from './creator-inquiry.service';

/**
 * CreatorInquiryModule — Этап 0 / Фаза 1 маркетплейса (ТЗ на маркетплейс
 * §21; ТЗ на бэкенд §6). Единственный «транзакционный» (в смысле бизнес-
 * действия, не денег) модуль Этапа 0 — не зависит от CreatorProfileModule/
 * PortfolioModule напрямую (читает Prisma сам), чтобы не плодить лишние
 * межмодульные импорты ради простого чтения таблицы каталога.
 */
@Module({
  controllers: [CreatorInquiryController],
  providers: [CreatorInquiryService],
})
export class CreatorInquiryModule {}
