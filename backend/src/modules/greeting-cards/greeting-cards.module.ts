import { Module } from '@nestjs/common';
import { GreetingCardsController } from './greeting-cards.controller';
import { GreetingCardsService } from './greeting-cards.service';

/** Титульная карточка и закрывающая подпись (фичи №38/№39). */
@Module({
  controllers: [GreetingCardsController],
  providers: [GreetingCardsService],
  exports: [GreetingCardsService],
})
export class GreetingCardsModule {}
