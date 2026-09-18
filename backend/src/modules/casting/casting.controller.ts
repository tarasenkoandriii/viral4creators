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

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { CastingService } from './casting.service';
import {
  CharacterPreviewResult,
  CharacterPreviewService,
} from './character-preview.service';
import { CharacterCasting } from '../../common/types/casting.types';
import {
  CastPhotoConfirmRequestDto,
  CastPhotoUploadUrlRequestDto,
  PutCastingRequestDto,
} from './dto/casting.dto';
import { CharacterPreviewRequestDto } from './dto/character-preview-request.dto';
import { UsePreviewAsPhotoRequestDto } from './dto/use-preview-as-photo-request.dto';

@Controller('sessions/:sessionId/characters')
export class CastingController {
  constructor(
    private readonly service: CastingService,
    private readonly preview: CharacterPreviewService,
  ) {}

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

  /**
   * Доп. запрос владельца продукта: статичное превью персонажа из
   * текстового описания — по двойному клику на описание, ещё нет
   * фото. Best-effort — `null`, если Gemini не смог, не 500.
   */
  @Post(':characterId/preview')
  async generatePreview(
    @Param('sessionId') sessionId: string,
    @Param('characterId') characterId: string,
    @Body() dto: CharacterPreviewRequestDto,
  ): Promise<CharacterPreviewResult> {
    // §6.8 doc/AI-SKETCH-SPEC.md: тариф, бюджет и владелец — до вызова
    // модели; квота на число картинок — внутри `generateFromText`.
    const userId = await this.service.assertPreviewAllowed(
      sessionId,
      characterId,
    );
    return this.preview.generateFromText(
      sessionId,
      characterId,
      dto.description,
      userId,
    );
  }

  /**
   * Доп. запрос владельца продукта: «использовать как фото» —
   * продвигает уже сгенерированное превью (`pathname` из ответа
   * `preview` выше) до статуса настоящего фото персонажа. Копирует
   * байты в путь, который ожидает `confirmPhoto()`, затем вызывает
   * его напрямую — переиспользует уже проверенную логику подтверждения
   * фото (та же, что у обычной загрузки), не дублирует её здесь.
   */
  @Post(':characterId/preview/use-as-photo')
  async usePreviewAsPhoto(
    @Param('sessionId') sessionId: string,
    @Param('characterId') characterId: string,
    @Body() dto: UsePreviewAsPhotoRequestDto,
  ): Promise<CharacterCasting> {
    // Тариф и персонаж — до копирования: иначе в хранилище оставался бы
    // файл фото, которое `confirmPhoto` затем отклонит.
    await this.service.assertCanReplaceCharacter(sessionId, characterId);
    const photoPathname = await this.preview.copyPreviewToPhotoPath(
      sessionId,
      characterId,
      dto.previewPathname,
    );
    if (!photoPathname) {
      throw new BadRequestException(
        'Не удалось скопировать превью — попробуйте сгенерировать его заново',
      );
    }
    return this.service.confirmPhoto(sessionId, characterId, {
      pathname: photoPathname,
      description: dto.description,
    });
  }
}
