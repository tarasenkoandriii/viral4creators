/**
 *   GET   /sessions/:id/greeting-scenes   текущий выбор и длительности
 *   PATCH /sessions/:id/greeting-scenes   { sceneCount }
 */

import { Body, Controller, Get, Param, Patch } from '@nestjs/common';
import { GreetingScenesService } from './greeting-scenes.service';
import { GreetingScenesRequestDto } from './dto/greeting-scenes.dto';
import { GreetingScenesView } from '../../common/types/greeting.types';

@Controller('sessions/:sessionId/greeting-scenes')
export class GreetingScenesController {
  constructor(private readonly service: GreetingScenesService) {}

  @Get()
  get(@Param('sessionId') sessionId: string): Promise<GreetingScenesView> {
    return this.service.get(sessionId);
  }

  @Patch()
  set(
    @Param('sessionId') sessionId: string,
    @Body() dto: GreetingScenesRequestDto,
  ): Promise<GreetingScenesView> {
    return this.service.setCount(sessionId, dto.sceneCount);
  }
}
