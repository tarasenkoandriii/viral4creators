/**
 * Правка брифа и сценария сессии-поздравления — этап C ТЗ
 * docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md §3.6.
 *
 * Владение сессией проверяет глобальный `SessionOwnerGuard` — как у
 * остальных маршрутов `/sessions/:sessionId/*`.
 */

import { Body, Controller, Param, Patch } from '@nestjs/common';
import { UpdateGreetingBriefDto } from '../project/dto/update-greeting-brief.dto';
import { UpdateGreetingScriptDto } from './dto/update-greeting-script.dto';
import {
  GreetingSessionEditService,
  SessionBriefEditResult,
  SessionScriptEditResult,
} from './greeting-session-edit.service';

@Controller('sessions/:sessionId')
export class GreetingSessionEditController {
  constructor(private readonly service: GreetingSessionEditService) {}

  @Patch('greeting-brief')
  updateBrief(
    @Param('sessionId') sessionId: string,
    @Body() dto: UpdateGreetingBriefDto,
  ): Promise<SessionBriefEditResult> {
    return this.service.updateBrief(sessionId, dto);
  }

  @Patch('greeting-script')
  updateScript(
    @Param('sessionId') sessionId: string,
    @Body() dto: UpdateGreetingScriptDto,
  ): Promise<SessionScriptEditResult> {
    return this.service.updateScript(sessionId, dto.speech);
  }
}
