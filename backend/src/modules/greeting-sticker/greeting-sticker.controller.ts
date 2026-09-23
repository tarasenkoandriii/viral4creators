/**
 *   GET    /sessions/:id/greeting-sticker?q=…   поиск + выбранное
 *   POST   /sessions/:id/greeting-sticker       { query, stickerId, placement? }
 *   PATCH  /sessions/:id/greeting-sticker       { placement }
 *   DELETE /sessions/:id/greeting-sticker       снять наклейку
 *
 * /sessions convention — предъявитель UUID сессии и есть право
 * доступа, как у соседних `greeting-*` контроллеров.
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { GreetingStickerService } from './greeting-sticker.service';
import {
  GreetingStickerPlacementRequestDto,
  GreetingStickerSelectRequestDto,
} from './dto/greeting-sticker.dto';
import { GreetingStickerView } from '../../common/types/greeting.types';

@Controller('sessions/:sessionId/greeting-sticker')
export class GreetingStickerController {
  constructor(private readonly service: GreetingStickerService) {}

  /**
   * GET, хотя вызов ходит к чужому API: он бесплатный и
   * идемпотентный, а выдача вдобавок кешируется на сутки — того
   * требуют условия Pixabay.
   */
  @Get()
  view(
    @Param('sessionId') sessionId: string,
    @Query('q') q?: string,
  ): Promise<GreetingStickerView> {
    return this.service.view(sessionId, q ?? '');
  }

  @Post()
  select(
    @Param('sessionId') sessionId: string,
    @Body() dto: GreetingStickerSelectRequestDto,
  ): Promise<GreetingStickerView> {
    return this.service.select(
      sessionId,
      dto.query,
      dto.stickerId,
      dto.placement ?? null,
    );
  }

  @Patch()
  move(
    @Param('sessionId') sessionId: string,
    @Body() dto: GreetingStickerPlacementRequestDto,
  ): Promise<GreetingStickerView> {
    return this.service.move(sessionId, dto.placement);
  }

  @Delete()
  clear(@Param('sessionId') sessionId: string): Promise<GreetingStickerView> {
    return this.service.clear(sessionId);
  }
}
