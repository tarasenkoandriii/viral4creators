/**
 * Голосовая реплика в брифе поздравления ДО старта сессии — этап K3 ТЗ
 * `docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md` §4А.2 п.3.
 *
 *   POST /projects/:projectId/greeting-voice/upload-url
 *        { fileName, fileSize, mimeType }  → { uploadUrl, pathname }
 *   POST /projects/:projectId/greeting-voice/understand
 *        { pathname, screen, pending? }    → VoiceUnderstandResult
 *
 * Бриф заполняется до того, как появится сессия, поэтому у брифа свой
 * вход — под `TelegramIdentityGuard`, как весь `/projects`, с проверкой
 * владельца проекта. После старта тот же разбор идёт через
 * `/sessions/:sessionId/voice/understand` — сервис один.
 */

import { Body, Controller, Param, Post, Req, UseGuards } from '@nestjs/common';
import {
  IdentifiedRequest,
  TelegramIdentityGuard,
} from '../telegram-auth/telegram-identity.guard';
import { localeFromRequest } from '../../common/locale';
import { RateLimit, RateLimitGuard } from '../../common/rate-limit';
import {
  VOICE_PROCESS_RATE_LIMIT,
  VOICE_UPLOAD_RATE_LIMIT,
} from './voice-rate-limits';
import { VoiceUnderstandResult } from '../../common/greeting-voice-intent';
import { GreetingVoiceUnderstandService } from './greeting-voice-understand.service';
import { VoiceUploadUrl } from './voice.service';
import {
  GreetingVoiceUploadUrlRequestDto,
  ProjectGreetingVoiceUnderstandRequestDto,
} from './dto/greeting-voice.dto';

@Controller('projects/:projectId/greeting-voice')
@UseGuards(TelegramIdentityGuard)
export class ProjectGreetingVoiceController {
  constructor(private readonly understanding: GreetingVoiceUnderstandService) {}

  @Post('upload-url')
  @UseGuards(RateLimitGuard)
  @RateLimit(VOICE_UPLOAD_RATE_LIMIT)
  createUploadUrl(
    @Req() req: IdentifiedRequest,
    @Param('projectId') projectId: string,
    @Body() dto: GreetingVoiceUploadUrlRequestDto,
  ): Promise<VoiceUploadUrl> {
    return this.understanding.createProjectUploadUrl(
      req.telegramUserId,
      projectId,
      dto,
    );
  }

  @Post('understand')
  @UseGuards(RateLimitGuard)
  @RateLimit(VOICE_PROCESS_RATE_LIMIT)
  understand(
    @Req() req: IdentifiedRequest,
    @Param('projectId') projectId: string,
    @Body() dto: ProjectGreetingVoiceUnderstandRequestDto,
  ): Promise<VoiceUnderstandResult> {
    return this.understanding.understandForProject(
      req.telegramUserId,
      projectId,
      dto,
      localeFromRequest(req),
    );
  }
}
