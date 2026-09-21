/**
 * POST/GET /sessions/:sessionId/greeting-video (ТЗ
 * TZ-Greeting-Video-Project-Type.md §5.3) — start/poll rendering for a
 * GREETING_VIDEO session. Same no-guard convention as the rest of
 * /sessions/* routes (SessionOwnerGuard, global, covers `:sessionId`).
 */

import { Controller, Get, Param, Post } from '@nestjs/common';
import { GreetingVideoService } from './greeting-video.service';
import { GeneratedVideo } from '../../common/types/generation.types';

@Controller('sessions/:sessionId/greeting-video')
export class GreetingVideoController {
  constructor(private readonly service: GreetingVideoService) {}

  @Post()
  start(@Param('sessionId') sessionId: string): Promise<GeneratedVideo> {
    return this.service.startVideo(sessionId);
  }

  @Get()
  poll(
    @Param('sessionId') sessionId: string,
  ): Promise<GeneratedVideo | undefined> {
    return this.service.pollVideo(sessionId);
  }
}
