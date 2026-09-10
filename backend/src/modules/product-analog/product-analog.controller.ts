/**
 * ProductAnalogController — photo → analogs + category, per ProductItem.
 * doc/PRODUCT-PROJECT-SPEC.md §4 Экраны 2–3; Stage 4 of the plan.
 *
 *   POST /projects/:projectId/items/:itemId/photo/upload-url
 *        → { uploadUrl, pathname }   (TMA then PUTs the file to uploadUrl)
 *   POST /projects/:projectId/items/:itemId/photo/process   { pathname }
 *        → { item, analogsSource, analogsReason?, recognitionReason? }
 *
 * Behind TelegramIdentityGuard like the rest of /projects (see
 * project.controller.ts). Global /api prefix applies.
 */

import { Body, Controller, Param, Post, Req, UseGuards } from '@nestjs/common';
import {
  IdentifiedRequest,
  TelegramIdentityGuard,
} from '../telegram-auth/telegram-identity.guard';
import {
  PhotoUploadUrl,
  ProcessPhotoResult,
  ProductAnalogService,
} from './product-analog.service';
import { PhotoUploadUrlRequestDto } from './dto/photo-upload-url-request.dto';
import { ProcessPhotoRequestDto } from './dto/process-photo-request.dto';

@Controller('projects/:projectId/items/:itemId/photo')
@UseGuards(TelegramIdentityGuard)
export class ProductAnalogController {
  constructor(private readonly service: ProductAnalogService) {}

  @Post('upload-url')
  createUploadUrl(
    @Req() req: IdentifiedRequest,
    @Param('projectId') projectId: string,
    @Param('itemId') itemId: string,
    @Body() dto: PhotoUploadUrlRequestDto,
  ): Promise<PhotoUploadUrl> {
    return this.service.createPhotoUploadUrl(
      req.telegramUserId,
      projectId,
      itemId,
      dto,
    );
  }

  @Post('process')
  process(
    @Req() req: IdentifiedRequest,
    @Param('projectId') projectId: string,
    @Param('itemId') itemId: string,
    @Body() dto: ProcessPhotoRequestDto,
  ): Promise<ProcessPhotoResult> {
    return this.service.processPhoto(
      req.telegramUserId,
      projectId,
      itemId,
      dto,
    );
  }
}
