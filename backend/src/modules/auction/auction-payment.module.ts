import { Module } from '@nestjs/common';
import { AuctionPaymentService } from './auction-payment.service';

/**
 * Отдельный от AuctionModule модуль намеренно — см. доккомментарий
 * AuctionPaymentService. PrismaModule глобальный (@Global()), явно
 * импортировать не нужно, тот же приём, что у BillingModule.
 */
@Module({
  providers: [AuctionPaymentService],
  exports: [AuctionPaymentService],
})
export class AuctionPaymentModule {}
