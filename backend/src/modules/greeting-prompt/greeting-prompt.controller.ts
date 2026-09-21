/**
 * POST /sessions/:sessionId/greeting-prompt (ТЗ
 * TZ-Greeting-Video-Project-Type.md §5.1/§5.2) — the GREETING_VIDEO
 * counterpart of POST /sessions/:sessionId/prompt (PromptController).
 *
 * No identity guard: same convention as the rest of /sessions/* routes —
 * the session UUID is the bearer secret (see ProjectSessionController's
 * doc-comment for why), and a session with a greetingBriefSnapshot can
 * only exist if its owner created it via the guarded
 * POST /projects/:id/greeting-brief/sessions route.
 */

import { Controller, Param, Post } from '@nestjs/common';
import { GreetingPromptService } from './greeting-prompt.service';
import { GenerationPrompt } from '../../common/types/prompt.types';

@Controller('sessions/:sessionId/greeting-prompt')
export class GreetingPromptController {
  constructor(private readonly service: GreetingPromptService) {}

  @Post()
  generate(@Param('sessionId') sessionId: string): Promise<GenerationPrompt> {
    return this.service.generateGreetingPrompt(sessionId);
  }
}
