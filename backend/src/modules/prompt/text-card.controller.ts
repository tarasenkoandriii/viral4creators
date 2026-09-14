/**
 *   POST /sessions/:sessionId/text-cards/ensure     render/refresh text-cards
 *
 * Доп. запрос владельца продукта (ТЗ VEO-MODEL-VERSION-CHOICE-SPEC.md
 * §20) — тот же принцип, что у `CastingController`: session-bearer,
 * без identity guard (анонимный мастер тоже готовит референсы).
 */
import { Body, Controller, Param, Post } from '@nestjs/common';
import { TextCardService } from './text-card.service';
import { OnScreenTextMoment } from '../../common/types/prompt.types';
import { EnsureTextCardsRequestDto } from './dto/ensure-text-cards-request.dto';

@Controller('sessions/:sessionId/text-cards')
export class TextCardController {
  constructor(private readonly service: TextCardService) {}

  @Post('ensure')
  ensure(
    @Param('sessionId') sessionId: string,
    @Body() dto: EnsureTextCardsRequestDto,
  ): Promise<OnScreenTextMoment[]> {
    return this.service.ensureTextCards(sessionId, dto.aspectRatio);
  }
}
