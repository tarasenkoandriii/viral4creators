/**
 *   GET    /sessions/:id/scenes                       uploaded scenes
 *   POST   /sessions/:id/scenes/upload-url            presigned PUT (mints sceneId)
 *   POST   /sessions/:id/scenes/confirm               { pathname, label, description? }
 *   PATCH  /sessions/:id/scenes/:sceneId              label / description
 *   DELETE /sessions/:id/scenes/:sceneId
 *   GET    /sessions/:id/references                   candidates + effective slots
 *   PUT    /sessions/:id/references                   { slots: [...] } (≤3, ordered)
 *   DELETE /sessions/:id/references                   back to the default rule
 *
 * /sessions convention — the session UUID is the bearer (spec §7.8).
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import { ReferenceAssetsService } from './reference-assets.service';
import {
  PutReferenceSlotsRequestDto,
  SceneConfirmRequestDto,
  ScenePhotoUploadUrlRequestDto,
  SceneUpdateRequestDto,
} from './dto/reference-assets.dto';
import {
  ReferenceSlotsView,
  SceneAsset,
} from '../../common/types/reference.types';

@Controller('sessions/:sessionId/scenes')
export class ScenesController {
  constructor(private readonly service: ReferenceAssetsService) {}

  @Get()
  list(@Param('sessionId') sessionId: string): Promise<SceneAsset[]> {
    return this.service.listScenes(sessionId);
  }

  @Post('upload-url')
  uploadUrl(
    @Param('sessionId') sessionId: string,
    @Body() dto: ScenePhotoUploadUrlRequestDto,
  ): Promise<{ uploadUrl: string; pathname: string; sceneId: string }> {
    return this.service.createUploadUrl(sessionId, dto);
  }

  @Post('confirm')
  confirm(
    @Param('sessionId') sessionId: string,
    @Body() dto: SceneConfirmRequestDto,
  ): Promise<SceneAsset[]> {
    return this.service.confirmScene(sessionId, dto);
  }

  @Patch(':sceneId')
  update(
    @Param('sessionId') sessionId: string,
    @Param('sceneId') sceneId: string,
    @Body() dto: SceneUpdateRequestDto,
  ): Promise<SceneAsset[]> {
    return this.service.updateScene(sessionId, sceneId, dto);
  }

  @Delete(':sceneId')
  remove(
    @Param('sessionId') sessionId: string,
    @Param('sceneId') sceneId: string,
  ): Promise<SceneAsset[]> {
    return this.service.deleteScene(sessionId, sceneId);
  }
}

@Controller('sessions/:sessionId/references')
export class ReferenceSlotsController {
  constructor(private readonly service: ReferenceAssetsService) {}

  @Get()
  get(@Param('sessionId') sessionId: string): Promise<ReferenceSlotsView> {
    return this.service.getSlots(sessionId);
  }

  @Put()
  put(
    @Param('sessionId') sessionId: string,
    @Body() dto: PutReferenceSlotsRequestDto,
  ): Promise<ReferenceSlotsView> {
    return this.service.putSlots(sessionId, dto);
  }

  @Delete()
  reset(@Param('sessionId') sessionId: string): Promise<ReferenceSlotsView> {
    return this.service.resetSlots(sessionId);
  }
}
