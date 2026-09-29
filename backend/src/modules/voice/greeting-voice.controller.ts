/**
 * Голосовая реплика в мастере поздравления — этап K2 ТЗ Greeting 2.0 §4А.
 *
 *   POST /sessions/:sessionId/voice/upload-url
 *        { fileName, fileSize, mimeType }  → { uploadUrl, pathname }
 *   POST /sessions/:sessionId/voice/transcribe
 *        { pathname }  → { status, text, scriptMismatch, hints, language }
 *
 * `language` — язык, на котором говорили, определённый провайдером по
 * звуку (Soniox); у Gemini — `null`.
 *
 * /sessions convention — предъявитель UUID сессии и есть право доступа,
 * как у соседних `greeting-*` контроллеров. Расшифровка ничего не
 * применяет: разбор в поля брифа и команды — этап K3.
 */

import { Body, Controller, Param, Post } from '@nestjs/common';
import {
  GreetingVoiceResult,
  GreetingVoiceService,
} from './greeting-voice.service';
import { VoiceUploadUrl } from './voice.service';
import {
  GreetingVoiceTranscribeRequestDto,
  GreetingVoiceUploadUrlRequestDto,
} from './dto/greeting-voice.dto';

@Controller('sessions/:sessionId/voice')
export class GreetingVoiceController {
  constructor(private readonly voice: GreetingVoiceService) {}

  @Post('upload-url')
  createUploadUrl(
    @Param('sessionId') sessionId: string,
    @Body() dto: GreetingVoiceUploadUrlRequestDto,
  ): Promise<VoiceUploadUrl> {
    return this.voice.createUploadUrl(sessionId, dto);
  }

  @Post('transcribe')
  transcribe(
    @Param('sessionId') sessionId: string,
    @Body() dto: GreetingVoiceTranscribeRequestDto,
  ): Promise<GreetingVoiceResult> {
    return this.voice.transcribe(sessionId, dto);
  }
}
