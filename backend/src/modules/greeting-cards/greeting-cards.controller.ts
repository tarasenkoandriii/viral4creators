/**
 *   GET   /sessions/:id/greeting-cards   текст карточек + заготовки
 *   PATCH /sessions/:id/greeting-cards   { title?, closing? }
 *
 * /sessions convention — предъявитель UUID сессии и есть право
 * доступа, как у соседних `greeting-*` контроллеров.
 */

import { Body, Controller, Get, Param, Patch } from '@nestjs/common';
import { GreetingCardsService } from './greeting-cards.service';
import { GreetingCardsRequestDto } from './dto/greeting-cards.dto';
import { GreetingCardsView } from '../../common/types/greeting.types';

@Controller('sessions/:sessionId/greeting-cards')
export class GreetingCardsController {
  constructor(private readonly service: GreetingCardsService) {}

  @Get()
  get(@Param('sessionId') sessionId: string): Promise<GreetingCardsView> {
    return this.service.get(sessionId);
  }

  @Patch()
  update(
    @Param('sessionId') sessionId: string,
    @Body() dto: GreetingCardsRequestDto,
  ): Promise<GreetingCardsView> {
    return this.service.update(sessionId, {
      title: dto.title ?? null,
      closing: dto.closing ?? null,
    });
  }
}
