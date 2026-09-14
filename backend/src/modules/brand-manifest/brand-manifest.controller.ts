/**
 * BrandManifestController — REST surface of the Brand Manifest section.
 * doc/PRODUCT-PROJECT-SPEC.md §12 ("Экран — управление манифестом");
 * Stage 7 of the plan.
 *
 *   POST   /brand-manifests                                   create
 *   GET    /brand-manifests                                   list (summaries)
 *   GET    /brand-manifests/:id                               full, with characters
 *   PATCH  /brand-manifests/:id                               title / styleNotes / filters / effects
 *   DELETE /brand-manifests/:id                               (projects keep living, unlinked)
 *   POST   /brand-manifests/:id/characters                    add character (label, description)
 *   PATCH  /brand-manifests/:id/characters/:cid
 *   DELETE /brand-manifests/:id/characters/:cid
 *   POST   /brand-manifests/:id/characters/:cid/photo/upload-url   presigned Blob PUT (png/jpeg)
 *   POST   /brand-manifests/:id/characters/:cid/photo/confirm      { pathname } → photoUrl saved
 *   POST/PATCH/DELETE /brand-manifests/:id/scenes[/:sid]           brand scenes (§17.1, Stage 22) —
 *   POST   /brand-manifests/:id/scenes/:sid/photo/{upload-url,confirm}   same DTOs and flow as characters
 *
 * Linking a manifest to a project is on the PROJECT side
 * (PATCH /projects/:id { brandManifestId }) — see ProjectController.
 * Behind TelegramIdentityGuard like /projects; global /api prefix.
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  IdentifiedRequest,
  TelegramIdentityGuard,
} from '../telegram-auth/telegram-identity.guard';
import {
  BrandManifestService,
  CharacterPhotoUploadUrl,
} from './brand-manifest.service';
import { BrandManifestRequestDto } from './dto/brand-manifest-request.dto';
import { BrandCharacterRequestDto } from './dto/brand-character-request.dto';
import { AddCharacterFromSessionCastDto } from './dto/add-character-from-session-cast.dto';
import {
  CharacterPhotoConfirmRequestDto,
  CharacterPhotoUploadUrlRequestDto,
} from './dto/character-photo.dto';
import {
  BrandCharacterView,
  BrandManifestSummaryView,
  BrandManifestView,
  BrandSceneView,
} from '../../common/types/brand-manifest.types';

@Controller('brand-manifests')
@UseGuards(TelegramIdentityGuard)
export class BrandManifestController {
  constructor(private readonly service: BrandManifestService) {}

  @Post()
  create(
    @Req() req: IdentifiedRequest,
    @Body() dto: BrandManifestRequestDto,
  ): Promise<BrandManifestView> {
    return this.service.create(req.telegramUserId, dto);
  }

  @Get()
  list(@Req() req: IdentifiedRequest): Promise<BrandManifestSummaryView[]> {
    return this.service.list(req.telegramUserId);
  }

  @Get(':manifestId')
  get(
    @Req() req: IdentifiedRequest,
    @Param('manifestId') manifestId: string,
  ): Promise<BrandManifestView> {
    return this.service.get(req.telegramUserId, manifestId);
  }

  @Patch(':manifestId')
  update(
    @Req() req: IdentifiedRequest,
    @Param('manifestId') manifestId: string,
    @Body() dto: BrandManifestRequestDto,
  ): Promise<BrandManifestView> {
    return this.service.update(req.telegramUserId, manifestId, dto);
  }

  @Delete(':manifestId')
  @HttpCode(204)
  remove(
    @Req() req: IdentifiedRequest,
    @Param('manifestId') manifestId: string,
  ): Promise<void> {
    return this.service.remove(req.telegramUserId, manifestId);
  }

  @Post(':manifestId/characters')
  addCharacter(
    @Req() req: IdentifiedRequest,
    @Param('manifestId') manifestId: string,
    @Body() dto: BrandCharacterRequestDto,
  ): Promise<BrandCharacterView> {
    return this.service.addCharacter(req.telegramUserId, manifestId, dto);
  }

  /**
   * Доп. запрос владельца продукта: сохранить замену персонажа с
   * экрана сессии (`CharacterCasting.tsx`) постоянным персонажем
   * бренда — не повторять фото/описание вручную в каждой новой сессии.
   */
  @Post(':manifestId/characters/from-session-cast')
  addCharacterFromSessionCast(
    @Req() req: IdentifiedRequest,
    @Param('manifestId') manifestId: string,
    @Body() dto: AddCharacterFromSessionCastDto,
  ): Promise<BrandCharacterView> {
    return this.service.addCharacterFromSessionCast(
      req.telegramUserId,
      manifestId,
      dto,
    );
  }

  @Patch(':manifestId/characters/:characterId')
  updateCharacter(
    @Req() req: IdentifiedRequest,
    @Param('manifestId') manifestId: string,
    @Param('characterId') characterId: string,
    @Body() dto: BrandCharacterRequestDto,
  ): Promise<BrandCharacterView> {
    return this.service.updateCharacter(
      req.telegramUserId,
      manifestId,
      characterId,
      dto,
    );
  }

  @Delete(':manifestId/characters/:characterId')
  @HttpCode(204)
  removeCharacter(
    @Req() req: IdentifiedRequest,
    @Param('manifestId') manifestId: string,
    @Param('characterId') characterId: string,
  ): Promise<void> {
    return this.service.removeCharacter(
      req.telegramUserId,
      manifestId,
      characterId,
    );
  }

  @Post(':manifestId/characters/:characterId/photo/upload-url')
  characterPhotoUploadUrl(
    @Req() req: IdentifiedRequest,
    @Param('manifestId') manifestId: string,
    @Param('characterId') characterId: string,
    @Body() dto: CharacterPhotoUploadUrlRequestDto,
  ): Promise<CharacterPhotoUploadUrl> {
    return this.service.createCharacterPhotoUploadUrl(
      req.telegramUserId,
      manifestId,
      characterId,
      dto,
    );
  }

  @Post(':manifestId/characters/:characterId/photo/confirm')
  confirmCharacterPhoto(
    @Req() req: IdentifiedRequest,
    @Param('manifestId') manifestId: string,
    @Param('characterId') characterId: string,
    @Body() dto: CharacterPhotoConfirmRequestDto,
  ): Promise<BrandCharacterView> {
    return this.service.confirmCharacterPhoto(
      req.telegramUserId,
      manifestId,
      characterId,
      dto,
    );
  }
  // ── Brand scenes (§17.1) ──────────────────────────────────────────────

  @Post(':manifestId/scenes')
  addScene(
    @Req() req: IdentifiedRequest,
    @Param('manifestId') manifestId: string,
    @Body() dto: BrandCharacterRequestDto,
  ): Promise<BrandSceneView> {
    return this.service.addScene(req.telegramUserId, manifestId, dto);
  }

  @Patch(':manifestId/scenes/:sceneId')
  updateScene(
    @Req() req: IdentifiedRequest,
    @Param('manifestId') manifestId: string,
    @Param('sceneId') sceneId: string,
    @Body() dto: BrandCharacterRequestDto,
  ): Promise<BrandSceneView> {
    return this.service.updateScene(
      req.telegramUserId,
      manifestId,
      sceneId,
      dto,
    );
  }

  @Delete(':manifestId/scenes/:sceneId')
  @HttpCode(204)
  removeScene(
    @Req() req: IdentifiedRequest,
    @Param('manifestId') manifestId: string,
    @Param('sceneId') sceneId: string,
  ): Promise<void> {
    return this.service.removeScene(req.telegramUserId, manifestId, sceneId);
  }

  @Post(':manifestId/scenes/:sceneId/photo/upload-url')
  scenePhotoUploadUrl(
    @Req() req: IdentifiedRequest,
    @Param('manifestId') manifestId: string,
    @Param('sceneId') sceneId: string,
    @Body() dto: CharacterPhotoUploadUrlRequestDto,
  ): Promise<CharacterPhotoUploadUrl> {
    return this.service.createScenePhotoUploadUrl(
      req.telegramUserId,
      manifestId,
      sceneId,
      dto,
    );
  }

  @Post(':manifestId/scenes/:sceneId/photo/confirm')
  confirmScenePhoto(
    @Req() req: IdentifiedRequest,
    @Param('manifestId') manifestId: string,
    @Param('sceneId') sceneId: string,
    @Body() dto: CharacterPhotoConfirmRequestDto,
  ): Promise<BrandSceneView> {
    return this.service.confirmScenePhoto(
      req.telegramUserId,
      manifestId,
      sceneId,
      dto,
    );
  }
}
