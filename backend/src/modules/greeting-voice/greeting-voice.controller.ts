/**
 *   GET   /sessions/:id/greeting-voice          выбранный голос
 *   GET   /sessions/:id/greeting-voice/presets  роестр пресетных голосов xAI
 *   PATCH /sessions/:id/greeting-voice          { resembleVoiceId } | { presetVoiceId }
 *
 * /sessions convention — предъявитель UUID сессии и есть право доступа
 * (как у соседнего `GreetingReferenceController`). Принадлежность
 * самого клона при этом проверяется отдельно, по `session.userId`, —
 * см. `GreetingVoiceService.resolveOwnClone`.
 */

import { Body, Controller, Get, Param, Patch } from '@nestjs/common';
import { GreetingVoiceService } from './greeting-voice.service';
import { GreetingSenderVoiceRequestDto } from './dto/greeting-voice.dto';
import { GreetingVoiceView } from '../../common/types/greeting.types';
import { GrokPresetVoice } from '../generation/grok-video.service';

@Controller('sessions/:sessionId/greeting-voice')
export class GreetingVoiceController {
  constructor(private readonly service: GreetingVoiceService) {}

  @Get()
  get(@Param('sessionId') sessionId: string): Promise<GreetingVoiceView> {
    return this.service.get(sessionId);
  }

  /**
   * GET, в отличие от соседнего `/greeting-references/settings`: этот
   * вызов ничего не генерирует и не стоит денег — просто читает
   * роестр у провайдера.
   */
  @Get('presets')
  presets(): Promise<GrokPresetVoice[]> {
    return this.service.listPresetVoices();
  }

  /**
   * Одна ручка на оба вида голоса, а не две: выбор взаимоисключающий,
   * и разделение на два маршрута означало бы, что клиент может
   * поставить оба и получить ролик, где реплику произносят дважды.
   * Здесь сервис сам гасит противоположное поле.
   */
  @Patch()
  select(
    @Param('sessionId') sessionId: string,
    @Body() dto: GreetingSenderVoiceRequestDto,
  ): Promise<GreetingVoiceView> {
    if (dto.presetVoiceId !== undefined) {
      return this.service.selectPreset(sessionId, dto.presetVoiceId ?? null);
    }
    return this.service.select(sessionId, dto.resembleVoiceId ?? null);
  }
}
