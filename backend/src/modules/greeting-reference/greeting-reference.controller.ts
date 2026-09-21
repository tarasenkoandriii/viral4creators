/**
 *   GET    /sessions/:id/greeting-references             uploaded reference images
 *   POST   /sessions/:id/greeting-references/upload-url  presigned PUT (mints imageId)
 *   POST   /sessions/:id/greeting-references/confirm     { pathname, label, description? }
 *   PATCH  /sessions/:id/greeting-references/:imageId    label / description
 *   DELETE /sessions/:id/greeting-references/:imageId
 *
 * /sessions convention — the session UUID is the bearer (same as
 * ScenesController next to it).
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { GreetingReferenceService } from './greeting-reference.service';
import {
  GreetingReferenceConfirmRequestDto,
  GreetingReferenceUpdateRequestDto,
  GreetingReferenceUploadUrlRequestDto,
} from './dto/greeting-reference.dto';
import { GreetingReferenceImageView } from '../../common/types/greeting.types';

@Controller('sessions/:sessionId/greeting-references')
export class GreetingReferenceController {
  constructor(private readonly service: GreetingReferenceService) {}

  @Get()
  list(
    @Param('sessionId') sessionId: string,
  ): Promise<GreetingReferenceImageView[]> {
    return this.service.list(sessionId);
  }

  @Post('upload-url')
  uploadUrl(
    @Param('sessionId') sessionId: string,
    @Body() dto: GreetingReferenceUploadUrlRequestDto,
  ): Promise<{ uploadUrl: string; pathname: string; imageId: string }> {
    return this.service.createUploadUrl(sessionId, dto);
  }

  @Post('confirm')
  confirm(
    @Param('sessionId') sessionId: string,
    @Body() dto: GreetingReferenceConfirmRequestDto,
  ): Promise<GreetingReferenceImageView[]> {
    return this.service.confirm(sessionId, dto);
  }

  @Patch(':imageId')
  update(
    @Param('sessionId') sessionId: string,
    @Param('imageId') imageId: string,
    @Body() dto: GreetingReferenceUpdateRequestDto,
  ): Promise<GreetingReferenceImageView[]> {
    return this.service.update(sessionId, imageId, dto);
  }

  @Delete(':imageId')
  remove(
    @Param('sessionId') sessionId: string,
    @Param('imageId') imageId: string,
  ): Promise<GreetingReferenceImageView[]> {
    return this.service.remove(sessionId, imageId);
  }
}
