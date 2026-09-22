/**
 *   GET   /sessions/:id/greeting-music             темы под повод + выбранная
 *   PATCH /sessions/:id/greeting-music             { themeId: string | null }
 *   POST  /sessions/:id/greeting-music/upload-url  presigned PUT для своей музыки
 *   POST  /sessions/:id/greeting-music/confirm     { pathname, title, rightsConfirmed }
 *   POST  /sessions/:id/greeting-music/link        { url, title, rightsConfirmed }
 *
 * /sessions convention — предъявитель UUID сессии и есть право
 * доступа, как у соседних `greeting-*` контроллеров.
 */

import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { GreetingMusicService } from './greeting-music.service';
import {
  GreetingMusicConfirmRequestDto,
  GreetingMusicLinkRequestDto,
  GreetingMusicRequestDto,
  GreetingMusicUploadUrlRequestDto,
} from './dto/greeting-music.dto';
import { GreetingMusicView } from '../../common/types/greeting.types';

@Controller('sessions/:sessionId/greeting-music')
export class GreetingMusicController {
  constructor(private readonly service: GreetingMusicService) {}

  @Get()
  get(@Param('sessionId') sessionId: string): Promise<GreetingMusicView> {
    return this.service.get(sessionId);
  }

  @Patch()
  select(
    @Param('sessionId') sessionId: string,
    @Body() dto: GreetingMusicRequestDto,
  ): Promise<GreetingMusicView> {
    return this.service.select(sessionId, dto.themeId ?? null);
  }

  @Post('upload-url')
  uploadUrl(
    @Param('sessionId') sessionId: string,
    @Body() dto: GreetingMusicUploadUrlRequestDto,
  ): Promise<{ uploadUrl: string; pathname: string; trackId: string }> {
    return this.service.createUploadUrl(sessionId, dto);
  }

  @Post('confirm')
  confirm(
    @Param('sessionId') sessionId: string,
    @Body() dto: GreetingMusicConfirmRequestDto,
  ): Promise<GreetingMusicView> {
    return this.service.confirmUpload(sessionId, dto);
  }

  @Post('link')
  link(
    @Param('sessionId') sessionId: string,
    @Body() dto: GreetingMusicLinkRequestDto,
  ): Promise<GreetingMusicView> {
    return this.service.selectLink(sessionId, dto);
  }
}
