/**
 * Голосовая реплика в мастере поздравления — этап K2 ТЗ Greeting 2.0 §4А.
 *
 *   POST /sessions/:sessionId/voice/upload-url
 *        { fileName, fileSize, mimeType }  → { uploadUrl, pathname }
 *   POST /sessions/:sessionId/voice/transcribe
 *        { pathname }  → { status, text, scriptMismatch, hints, language, reason? }
 *        (клиент мастера с K3 им не пользуется; маршрут жив и стоит за тем
 *        же входом, что разбор — выключатель оператора и потолки)
 *   POST /sessions/:sessionId/voice/understand (этап K3)
 *        { pathname, screen, pending? }  → VoiceUnderstandResult
 *        (`common/greeting-voice-intent.ts`) — распознавание + разбор в
 *        поля брифа и команды; до старта сессии тот же разбор идёт через
 *        `projects/:projectId/greeting-voice/understand`.
 *
 * `language` — язык, на котором говорили, определённый провайдером по
 * звуку (Soniox); у Gemini — `null`.
 *
 * /sessions convention — предъявитель UUID сессии и есть право доступа,
 * как у соседних `greeting-*` контроллеров. Расшифровка ничего не
 * применяет: разбор в поля брифа и команды — этап K3.
 */

import { Body, Controller, Param, Post, Req, UseGuards } from '@nestjs/common';
import { RateLimit, RateLimitGuard } from '../../common/rate-limit';
import {
  VOICE_PROCESS_RATE_LIMIT,
  VOICE_UPLOAD_RATE_LIMIT,
} from './voice-rate-limits';
import { Request } from 'express';
import { localeFromRequest } from '../../common/locale';
import { VoiceUnderstandResult } from '../../common/greeting-voice-intent';
import { GreetingVoiceUnderstandService } from './greeting-voice-understand.service';
import {
  GreetingVoiceResult,
  GreetingVoiceService,
} from './greeting-voice.service';
import { VoiceUploadUrl } from './voice.service';
import {
  GreetingVoiceTranscribeRequestDto,
  GreetingVoiceUnderstandRequestDto,
  GreetingVoiceUploadUrlRequestDto,
} from './dto/greeting-voice.dto';

@Controller('sessions/:sessionId/voice')
export class GreetingVoiceController {
  constructor(
    private readonly voice: GreetingVoiceService,
    private readonly understanding: GreetingVoiceUnderstandService,
  ) {}

  @Post('upload-url')
  @UseGuards(RateLimitGuard)
  @RateLimit(VOICE_UPLOAD_RATE_LIMIT)
  createUploadUrl(
    @Param('sessionId') sessionId: string,
    @Body() dto: GreetingVoiceUploadUrlRequestDto,
  ): Promise<VoiceUploadUrl> {
    return this.voice.createUploadUrl(sessionId, dto);
  }

  @Post('transcribe')
  @UseGuards(RateLimitGuard)
  @RateLimit(VOICE_PROCESS_RATE_LIMIT)
  transcribe(
    @Param('sessionId') sessionId: string,
    @Body() dto: GreetingVoiceTranscribeRequestDto,
  ): Promise<GreetingVoiceResult> {
    // Тот же вход, что у разбора (финальный аудит ветки K): выключатель
    // оператора и потолки — до платного вызова.
    return this.understanding.transcribeForSession(sessionId, dto);
  }

  @Post('understand')
  @UseGuards(RateLimitGuard)
  @RateLimit(VOICE_PROCESS_RATE_LIMIT)
  understand(
    @Req() req: Request,
    @Param('sessionId') sessionId: string,
    @Body() dto: GreetingVoiceUnderstandRequestDto,
  ): Promise<VoiceUnderstandResult> {
    // Язык интерфейса — из `Accept-Language` (его ставит клиент на
    // каждый запрос): подписи карточки и реплика без языка речи.
    return this.understanding.understandForSession(
      sessionId,
      dto,
      localeFromRequest(req),
    );
  }
}
