/**
 * HTTP ИИ-скетча (doc/AI-SKETCH-SPEC.md §6.2). Личность обязательна:
 * квоты и журнал считаются по пользователю, у гостя их нет.
 */

import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  IdentifiedRequest,
  TelegramIdentityGuard,
} from '../telegram-auth/telegram-identity.guard';
import { ImageSketchService } from './image-sketch.service';
import {
  ApplySketchRequestDto,
  GenerateSketchRequestDto,
  SketchTargetRequestDto,
} from './dto/sketch.dto';
import {
  SketchQuotaView,
  SketchSlotView,
  SketchTarget,
  SketchTargetType,
  SketchView,
} from '../../common/types/sketch.types';

@Controller('sketches')
@UseGuards(TelegramIdentityGuard)
export class ImageSketchController {
  constructor(private readonly service: ImageSketchService) {}

  @Post()
  generate(
    @Req() req: IdentifiedRequest,
    @Body() dto: GenerateSketchRequestDto,
  ): Promise<{ sketch: SketchView; quota: SketchQuotaView }> {
    return this.service.generate(
      {
        target: dto.target,
        mode: dto.mode,
        style: dto.style,
        options: dto.options,
        description: dto.description,
      },
      req.telegramUserId,
    );
  }

  @Get()
  list(
    @Req() req: IdentifiedRequest,
    @Query('type') type: string,
    @Query('id') id: string,
    @Query('subId') subId?: string,
  ): Promise<{
    items: SketchView[];
    active: SketchView | null;
    quota: SketchQuotaView;
  }> {
    const target: SketchTarget = {
      type: type as SketchTargetType,
      id,
      subId: subId ?? null,
    };
    return this.service.list(target, req.telegramUserId);
  }

  @Get('quota')
  quota(@Req() req: IdentifiedRequest): Promise<SketchQuotaView> {
    return this.service.quota(req.telegramUserId);
  }

  @Post(':sketchId/apply')
  async apply(
    @Req() req: IdentifiedRequest,
    @Param('sketchId') sketchId: string,
    @Body() dto: ApplySketchRequestDto,
  ): Promise<{ slot: SketchSlotView }> {
    return {
      slot: await this.service.apply(
        sketchId,
        req.telegramUserId,
        dto.sketchRendering,
      ),
    };
  }

  @Post('revert')
  async revert(
    @Req() req: IdentifiedRequest,
    @Body() dto: SketchTargetRequestDto,
  ): Promise<{ slot: SketchSlotView }> {
    return { slot: await this.service.revert(dto.target, req.telegramUserId) };
  }

  @Post('delete-original')
  deleteOriginal(
    @Req() req: IdentifiedRequest,
    @Body() dto: SketchTargetRequestDto,
  ): Promise<{
    slot: SketchSlotView;
    updatedRefs: number;
    /** `false` — файл был общим и остался жить у владельца (аудит A-4). */
    fileDeleted: boolean;
  }> {
    return this.service.deleteOriginal(dto.target, req.telegramUserId);
  }
}
