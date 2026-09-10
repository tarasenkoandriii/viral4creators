/**
 *   GET  /sessions/:sessionId/characters                         current casting
 *   PUT  /sessions/:sessionId/characters                         replace casting
 *   POST /sessions/:sessionId/characters/:characterId/photo/upload-url
 *   POST /sessions/:sessionId/characters/:characterId/photo/confirm
 *
 * /sessions convention: the session UUID is the bearer, no identity
 * guard — the anonymous wizard casts characters too (spec §10 applies to
 * every generation, project-bound or not).
 */

import { Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
import { CastingService } from './casting.service';
import { CharacterCasting } from '../../common/types/casting.types';
import {
  CastPhotoConfirmRequestDto,
  CastPhotoUploadUrlRequestDto,
  PutCastingRequestDto,
} from './dto/casting.dto';

@Controller('sessions/:sessionId/characters')
export class CastingController {
  constructor(private readonly service: CastingService) {}

  @Get()
  get(@Param('sessionId') sessionId: string): Promise<CharacterCasting> {
    return this.service.get(sessionId);
  }

  @Put()
  put(
    @Param('sessionId') sessionId: string,
    @Body() dto: PutCastingRequestDto,
  ): Promise<CharacterCasting> {
    return this.service.put(sessionId, dto);
  }

  @Post(':characterId/photo/upload-url')
  uploadUrl(
    @Param('sessionId') sessionId: string,
    @Param('characterId') characterId: string,
    @Body() dto: CastPhotoUploadUrlRequestDto,
  ): Promise<{ uploadUrl: string; pathname: string }> {
    return this.service.createPhotoUploadUrl(sessionId, characterId, dto);
  }

  @Post(':characterId/photo/confirm')
  confirm(
    @Param('sessionId') sessionId: string,
    @Param('characterId') characterId: string,
    @Body() dto: CastPhotoConfirmRequestDto,
  ): Promise<CharacterCasting> {
    return this.service.confirmPhoto(sessionId, characterId, dto);
  }
}
