/**
 * HTTP образов рассказчика Story‑Tales (WP5, TODO стр. 79):
 *
 *   GET    /brand-manifests/:manifestId/narrator-looks                       состояние: согласие, режим, активный образ, квота, цена, варианты
 *   POST   /brand-manifests/:manifestId/narrator-looks/consent               { version: 'story-parent-image-v1', accepted: true }
 *   DELETE /brand-manifests/:manifestId/narrator-looks/consent               отзыв согласия
 *   POST   /brand-manifests/:manifestId/narrator-looks                       { outfit, makeup, maxReserveMicroUsd, repeat? } — платно
 *   POST   /brand-manifests/:manifestId/narrator-looks/revert                откат к оригиналу
 *   GET    /brand-manifests/:manifestId/narrator-looks/:lookId/image?asset=photo|styled → { base64, mime, hash } (≤3 МиБ, иначе 413)
 *   GET    /brand-manifests/:manifestId/narrator-looks/:lookId/image/raw?asset=photo|styled → байты (image/*, X-Narrator-Look-Hash)
 *          оба превью — Cache-Control: private, no-store; X-Robots-Tag: noindex
 *   POST   /brand-manifests/:manifestId/narrator-looks/:lookId/apply         применить (только явно)
 *   POST   /brand-manifests/:manifestId/narrator-looks/:lookId/restyle       { maxReserveMicroUsd, repeat? } — платно, под текущий режим
 *   DELETE /brand-manifests/:manifestId/narrator-looks/:lookId               удалить вариант (байты стираются)
 *
 * Брендбук общий (TelegramIdentityGuard, владелец по userId), но функция
 * — только для Story: закрытая разработка, поэтому ещё и
 * `StoryDevelopmentGuard` (не владелец Story — 404). Р-ST-WP5-1.
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  IdentifiedRequest,
  TelegramIdentityGuard,
} from '../telegram-auth/telegram-identity.guard';
import { StoryDevelopmentGuard } from '../story-gifts/story-development.guard';
import {
  NarratorLooksService,
  NarratorLooksView,
  NarratorLookView,
} from './narrator-looks.service';
import {
  CreateNarratorLookDto,
  NarratorImageConsentDto,
  RestyleNarratorLookDto,
} from './dto/narrator-looks.dto';

/** Личное изображение образа: не кешировать, не индексировать (A-S3-10). */
export const PRIVATE_IMAGE_HEADERS: Readonly<Record<string, string>> = {
  'Cache-Control': 'private, no-store',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

@Controller('brand-manifests')
@UseGuards(TelegramIdentityGuard, StoryDevelopmentGuard)
export class NarratorLooksController {
  constructor(private readonly looks: NarratorLooksService) {}

  /** ST2-R-01: личные метаданные образа — не кешировать, не индексировать. */
  @Get(':manifestId/narrator-looks')
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Robots-Tag', 'noindex, nofollow, noarchive')
  view(
    @Req() req: IdentifiedRequest,
    @Param('manifestId') manifestId: string,
  ): Promise<NarratorLooksView> {
    return this.looks.view(req.telegramUserId, manifestId);
  }

  @Post(':manifestId/narrator-looks/consent')
  acceptConsent(
    @Req() req: IdentifiedRequest,
    @Param('manifestId') manifestId: string,
    @Body() dto: NarratorImageConsentDto,
  ): Promise<NarratorLooksView> {
    return this.looks.acceptConsent(req.telegramUserId, manifestId, dto);
  }

  @Delete(':manifestId/narrator-looks/consent')
  revokeConsent(
    @Req() req: IdentifiedRequest,
    @Param('manifestId') manifestId: string,
  ): Promise<NarratorLooksView> {
    return this.looks.revokeConsent(req.telegramUserId, manifestId);
  }

  @Post(':manifestId/narrator-looks')
  create(
    @Req() req: IdentifiedRequest,
    @Param('manifestId') manifestId: string,
    @Body() dto: CreateNarratorLookDto,
  ): Promise<{ look: NarratorLookView; reused: boolean }> {
    return this.looks.create(req.telegramUserId, manifestId, dto);
  }

  @Post(':manifestId/narrator-looks/revert')
  revert(
    @Req() req: IdentifiedRequest,
    @Param('manifestId') manifestId: string,
  ): Promise<NarratorLooksView> {
    return this.looks.revert(req.telegramUserId, manifestId);
  }

  /**
   * A-S3-10: личное изображение — никогда не кешируется и не индексируется
   * (как страницы Story). JSON (совместимо с фронтом) — до 3 МиБ байтов,
   * больше — 413 NARRATOR_LOOK_IMAGE_TOO_LARGE; тогда `…/image/raw`.
   */
  @Get(':manifestId/narrator-looks/:lookId/image')
  image(
    @Req() req: IdentifiedRequest,
    @Param('manifestId') manifestId: string,
    @Param('lookId') lookId: string,
    @Query('asset') asset: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ base64: string; mime: string; hash: string }> {
    res.set(PRIVATE_IMAGE_HEADERS);
    return this.looks.image(
      req.telegramUserId,
      manifestId,
      lookId,
      asset ?? 'photo',
    );
  }

  /**
   * Те же байты без base64 (≤4 000 000 байт — под лимитом ответа Vercel): ответ —
   * само изображение, мимо JSON-конверта. Хеш — в `X-Narrator-Look-Hash`.
   */
  @Get(':manifestId/narrator-looks/:lookId/image/raw')
  async imageRaw(
    @Req() req: IdentifiedRequest,
    @Param('manifestId') manifestId: string,
    @Param('lookId') lookId: string,
    @Query('asset') asset: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    res.set(PRIVATE_IMAGE_HEADERS);
    const img = await this.looks.imageBytes(
      req.telegramUserId,
      manifestId,
      lookId,
      asset ?? 'photo',
    );
    res
      .set({
        'Content-Type': img.mime,
        'Content-Disposition': 'inline',
        'X-Narrator-Look-Hash': img.hash,
      })
      .send(img.bytes);
  }

  @Post(':manifestId/narrator-looks/:lookId/apply')
  apply(
    @Req() req: IdentifiedRequest,
    @Param('manifestId') manifestId: string,
    @Param('lookId') lookId: string,
  ): Promise<NarratorLooksView> {
    return this.looks.apply(req.telegramUserId, manifestId, lookId);
  }

  @Post(':manifestId/narrator-looks/:lookId/restyle')
  restyle(
    @Req() req: IdentifiedRequest,
    @Param('manifestId') manifestId: string,
    @Param('lookId') lookId: string,
    @Body() dto: RestyleNarratorLookDto,
  ): Promise<{ look: NarratorLookView; reused: boolean }> {
    return this.looks.restyle(req.telegramUserId, manifestId, lookId, dto);
  }

  @Delete(':manifestId/narrator-looks/:lookId')
  remove(
    @Req() req: IdentifiedRequest,
    @Param('manifestId') manifestId: string,
    @Param('lookId') lookId: string,
  ): Promise<NarratorLooksView> {
    return this.looks.remove(req.telegramUserId, manifestId, lookId);
  }
}
