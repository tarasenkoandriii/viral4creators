/**
 *   GET   /sessions/:id/greeting-voice   выбранный голос отправителя
 *   PATCH /sessions/:id/greeting-voice   { resembleVoiceId: string | null }
 *
 * /sessions convention — предъявитель UUID сессии и есть право доступа
 * (как у соседнего `GreetingReferenceController`). Принадлежность
 * самого голоса при этом проверяется отдельно, по `session.userId`, —
 * см. `GreetingVoiceService.resolveOwnClone`.
 */

import { Body, Controller, Get, Param, Patch } from '@nestjs/common';
import { GreetingVoiceService } from './greeting-voice.service';
import { GreetingSenderVoiceRequestDto } from './dto/greeting-voice.dto';
import { GreetingSenderVoice } from '../../common/types/greeting.types';

@Controller('sessions/:sessionId/greeting-voice')
export class GreetingVoiceController {
  constructor(private readonly service: GreetingVoiceService) {}

  @Get()
  get(
    @Param('sessionId') sessionId: string,
  ): Promise<GreetingSenderVoice | null> {
    return this.service.get(sessionId);
  }

  @Patch()
  select(
    @Param('sessionId') sessionId: string,
    @Body() dto: GreetingSenderVoiceRequestDto,
  ): Promise<GreetingSenderVoice | null> {
    return this.service.select(sessionId, dto.resembleVoiceId ?? null);
  }
}
