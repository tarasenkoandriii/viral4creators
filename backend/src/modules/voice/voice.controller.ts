/**
 * VoiceController — voice note → item description.
 * doc/PRODUCT-PROJECT-SPEC.md §4 Экран 4, §6.2; Stage 5.
 *
 *   POST /projects/:projectId/items/:itemId/voice/upload-url
 *        { fileName, fileSize, mimeType }  → { uploadUrl, pathname }
 *   POST /projects/:projectId/items/:itemId/voice/transcribe
 *        { pathname, apply? }              → { text, applied, reason? }
 *
 * Behind TelegramIdentityGuard like every /projects route; global /api prefix.
 */

import { Body, Controller, Param, Post, Req, UseGuards } from '@nestjs/common';
import {
  IdentifiedRequest,
  TelegramIdentityGuard,
} from '../telegram-auth/telegram-identity.guard';
import {
  TranscribeResult,
  VoiceService,
  VoiceUploadUrl,
} from './voice.service';
import { VoiceUploadUrlRequestDto } from './dto/voice-upload-url-request.dto';
import { TranscribeRequestDto } from './dto/transcribe-request.dto';

@Controller('projects/:projectId/items/:itemId/voice')
@UseGuards(TelegramIdentityGuard)
export class VoiceController {
  constructor(private readonly voice: VoiceService) {}

  @Post('upload-url')
  createUploadUrl(
    @Req() req: IdentifiedRequest,
    @Param('projectId') projectId: string,
    @Param('itemId') itemId: string,
    @Body() dto: VoiceUploadUrlRequestDto,
  ): Promise<VoiceUploadUrl> {
    return this.voice.createUploadUrl(
      req.telegramUserId,
      projectId,
      itemId,
      dto,
    );
  }

  @Post('transcribe')
  transcribe(
    @Req() req: IdentifiedRequest,
    @Param('projectId') projectId: string,
    @Param('itemId') itemId: string,
    @Body() dto: TranscribeRequestDto,
  ): Promise<TranscribeResult> {
    return this.voice.transcribe(req.telegramUserId, projectId, itemId, dto);
  }
}
