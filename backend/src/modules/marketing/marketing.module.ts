import { Module } from '@nestjs/common';
import { MarketingConsentController } from './marketing-consent.controller';
import { MarketingConsentService } from './marketing-consent.service';
import { MarketingBroadcastService } from './marketing-broadcast.service';

/** Рекламный канал — согласие на рассылку и крон-воркер её доставки
 * (ТЗ §42, этап 63). */
@Module({
  controllers: [MarketingConsentController],
  providers: [MarketingConsentService, MarketingBroadcastService],
  exports: [MarketingConsentService, MarketingBroadcastService],
})
export class MarketingModule {}
