/**
 *   GET    /sessions/:id/greeting-references             uploaded reference images
 *   POST   /sessions/:id/greeting-references/upload-url  presigned PUT (mints imageId)
 *   POST   /sessions/:id/greeting-references/confirm     { pathname, label, description? }
 *   POST   /sessions/:id/greeting-references/settings    три варианта сеттинга (фича №36)
 *   POST   /sessions/:id/greeting-references/generate    нарисовать кадр по брифу (фича №6)
 *   PATCH  /sessions/:id/greeting-references/:imageId    label / description / faceConsent (Г-8)
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
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  RateLimit,
  RateLimitGuard,
  RateLimitRule,
} from '../../common/rate-limit';
import { TelegramIdentifiedRequest } from '../telegram-auth/telegram-identity.middleware';
import { GreetingReferenceService } from './greeting-reference.service';
import {
  GreetingFrameRequestDto,
  GreetingReferenceConfirmRequestDto,
  GreetingReferenceUpdateRequestDto,
  GreetingReferenceUploadUrlRequestDto,
} from './dto/greeting-reference.dto';
import { GreetingReferenceImageView } from '../../common/types/greeting.types';

/**
 * Частота платных маршрутов (CONTRACT6 п.1) — по образцу голосовых
 * (`voice-rate-limits.ts`). Суточный потолок считает деньги ПОСЛЕ вызова,
 * и пачка параллельных запросов проходит его одновременно; окно делает
 * этот перебор маленьким. Кадр — самый дорогой (модель изображений):
 * 10 в минуту человеку хватает с запасом. По человеку: за одним адресом
 * мини-аппа сидит весь оператор связи; анонимный — по адресу.
 */
export const GREETING_FRAME_RATE_LIMIT: RateLimitRule[] = [
  { name: 'greeting-frame', limit: 10, windowSec: 60, by: 'user' },
  { name: 'greeting-frame-hour', limit: 60, windowSec: 3600, by: 'user' },
];
/** Варианты сеттинга — дешёвый текстовый вызов, окно шире. */
export const GREETING_SETTINGS_RATE_LIMIT: RateLimitRule[] = [
  { name: 'greeting-settings', limit: 20, windowSec: 60, by: 'user' },
  { name: 'greeting-settings-hour', limit: 200, windowSec: 3600, by: 'user' },
];
/** Подтверждение фото — при включённом режиме платная проверка лица. */
export const GREETING_REFERENCE_CONFIRM_RATE_LIMIT: RateLimitRule[] = [
  { name: 'greeting-ref-confirm', limit: 20, windowSec: 60, by: 'user' },
  {
    name: 'greeting-ref-confirm-hour',
    limit: 200,
    windowSec: 3600,
    by: 'user',
  },
];

@Controller('sessions/:sessionId/greeting-references')
export class GreetingReferenceController {
  constructor(private readonly service: GreetingReferenceService) {}

  @Get()
  list(
    @Param('sessionId') sessionId: string,
  ): Promise<GreetingReferenceImageView[]> {
    return this.service.list(sessionId);
  }

  /**
   * Референс-кадр по брифу сессии (фича №6).
   *
   * Без гарда личности, как и соседи: у этого контроллера предъявитель — сам
   * UUID сессии, и `GREETING_VIDEO` доступен на каждом тарифе (см.
   * доккомментарий сервиса). `telegramUserId` берётся из глобального
   * middleware и может быть пустым — он нужен только чтобы приписать
   * расход пользователю в отчёте, а не чтобы разрешить вызов.
   */
  @Post('generate')
  @UseGuards(RateLimitGuard)
  @RateLimit(GREETING_FRAME_RATE_LIMIT)
  generate(
    @Req() req: TelegramIdentifiedRequest,
    @Param('sessionId') sessionId: string,
    @Body() dto: GreetingFrameRequestDto,
  ): Promise<GreetingReferenceImageView[]> {
    return this.service.generateFrame(
      sessionId,
      req.telegramUserId ?? null,
      dto.setting ?? null,
    );
  }

  /**
   * Три варианта сеттинга под повод (фича №36) — дешёвый текстовый
   * вызов перед дорогим рисованием.
   *
   * POST, а не GET, хотя ничего не меняет: вызов платный и
   * неидемпотентный по расходу. GET здесь означал бы, что его можно
   * кешировать и дёргать повторно бесплатно, — а нельзя.
   */
  @Post('settings')
  @UseGuards(RateLimitGuard)
  @RateLimit(GREETING_SETTINGS_RATE_LIMIT)
  settings(
    @Req() req: TelegramIdentifiedRequest,
    @Param('sessionId') sessionId: string,
  ): Promise<string[]> {
    return this.service.suggestSettings(sessionId, req.telegramUserId ?? null);
  }

  @Post('upload-url')
  uploadUrl(
    @Param('sessionId') sessionId: string,
    @Body() dto: GreetingReferenceUploadUrlRequestDto,
  ): Promise<{ uploadUrl: string; pathname: string; imageId: string }> {
    return this.service.createUploadUrl(sessionId, dto);
  }

  @Post('confirm')
  @UseGuards(RateLimitGuard)
  @RateLimit(GREETING_REFERENCE_CONFIRM_RATE_LIMIT)
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
