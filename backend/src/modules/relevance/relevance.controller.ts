/**
 *   GET   /sessions/:id/relevance          current report (report: null before the first run)
 *   POST  /sessions/:id/relevance          run / re-run the match
 *   PATCH /sessions/:id/relevance          { useInPrompt }
 *
 * /sessions convention — the session UUID is the bearer (spec §7.8).
 */

import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { RelevanceService } from './relevance.service';
import { UpdateRelevanceRequestDto } from './dto/relevance.dto';
import { RelevanceState } from '../../common/types/relevance.types';

@Controller('sessions/:sessionId/relevance')
export class RelevanceController {
  constructor(private readonly service: RelevanceService) {}

  @Get()
  get(@Param('sessionId') sessionId: string): Promise<RelevanceState> {
    return this.service.get(sessionId);
  }

  @Post()
  run(@Param('sessionId') sessionId: string): Promise<RelevanceState> {
    return this.service.run(sessionId);
  }

  @Patch()
  update(
    @Param('sessionId') sessionId: string,
    @Body() dto: UpdateRelevanceRequestDto,
  ): Promise<RelevanceState> {
    return this.service.update(sessionId, dto.useInPrompt);
  }
}
