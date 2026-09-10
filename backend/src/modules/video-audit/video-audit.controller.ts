/**
 *   GET  /sessions/:sessionId/audit          history + iteration counter
 *   POST /sessions/:sessionId/audit          run (Gemini video audit, or a user-reported issue → fix)
 *   POST /sessions/:sessionId/audit/apply    push a fix into the prompt draft
 *   GET  /sessions/:sessionId/sound-check    history (этап 73)
 *   POST /sessions/:sessionId/sound-check    run (Gemini voice-realism check, separate from the artefact audit above)
 *
 * /sessions convention — session UUID is the bearer. The run call is
 * synchronous like analysis: one Gemini call on an 8-second clip.
 */

import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import {
  ApplyFixResult,
  AuditStateView,
  VideoAuditService,
} from './video-audit.service';
import { ApplyFixRequestDto, RunAuditRequestDto } from './dto/audit.dto';
import { SoundCheck } from '../../common/types/audit.types';

@Controller('sessions/:sessionId/audit')
export class VideoAuditController {
  constructor(private readonly service: VideoAuditService) {}

  @Get()
  get(@Param('sessionId') sessionId: string): Promise<AuditStateView> {
    return this.service.getState(sessionId);
  }

  @Post()
  run(
    @Param('sessionId') sessionId: string,
    @Body() dto: RunAuditRequestDto,
  ): Promise<AuditStateView> {
    return this.service.run(sessionId, dto);
  }

  @Post('apply')
  apply(
    @Param('sessionId') sessionId: string,
    @Body() dto: ApplyFixRequestDto,
  ): Promise<ApplyFixResult> {
    return this.service.applyFix(sessionId, dto);
  }
}

/**
 * Отдельный контроллер, не ещё один маршрут на `VideoAuditController`
 * (этап 73) — `/sessions/:id/sound-check` не про артефакты, а про
 * реализм голоса; отдельный путь читается честнее, чем `/audit/sound`.
 */
@Controller('sessions/:sessionId/sound-check')
export class SoundCheckController {
  constructor(private readonly service: VideoAuditService) {}

  @Get()
  get(
    @Param('sessionId') sessionId: string,
  ): Promise<{ history: SoundCheck[] }> {
    return this.service.getSoundCheckState(sessionId);
  }

  @Post()
  run(
    @Param('sessionId') sessionId: string,
  ): Promise<{ history: SoundCheck[] }> {
    return this.service.runSoundCheck(sessionId);
  }
}
