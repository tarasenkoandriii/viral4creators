/**
 * Own side (TelegramIdentityGuard — становление Creator требует identity,
 * ТЗ §21.8):
 *   POST  /creator-profiles/quiz    квиз исполнителя, создаёт профиль
 *   GET   /creator-profiles/me      свой профиль
 *   PATCH /creator-profiles/me      редактирование + toggle isAcceptingOrders
 *   GET   /creator-profiles/me/stats минимальная аналитика (§20 №14)
 *
 * Public side (no guard — витрина открыта без входа, ТЗ §9):
 *   GET  /creators              каталог (фильтры: niche, priceMax; keyset-курсор)
 *   GET  /creators/:idOrSlug    страница профиля (id ИЛИ vanity-slug, §20 №1)
 *   POST /creators/:idOrSlug/view      best-effort счётчик просмотров (§20 №13)
 *   GET  /creators/:id/similar         похожие креаторы (§20 №17)
 *
 * Admin (AdminSessionGuard):
 *   GET   /admin/creator-profiles              список всех профилей (§20 №19)
 *   PATCH /admin/creator-profiles/:id/featured   редакционный бейдж (§20 №19)
 */

import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  IdentifiedRequest,
  TelegramIdentityGuard,
} from '../telegram-auth/telegram-identity.guard';
import {
  AdminAuthenticatedRequest,
  AdminSessionGuard,
} from '../admin-auth/admin-session.guard';
import { AdminPanelService } from '../admin-panel/admin-panel.service';
import { CreatorProfileService } from './creator-profile.service';
import {
  CreatorQuizDto,
  UpdateCreatorProfileDto,
} from './dto/creator-profile.dto';
import { SetFeaturedDto } from './dto/set-featured.dto';
import {
  AdminCreatorProfileListResult,
  CreatorCatalogResult,
  CreatorProfileView,
  CreatorStatsView,
  SimilarCreatorView,
} from '../../common/types/marketplace.types';

@Controller('creator-profiles')
@UseGuards(TelegramIdentityGuard)
export class CreatorProfileController {
  constructor(private readonly service: CreatorProfileService) {}

  @Post('quiz')
  quiz(
    @Req() req: IdentifiedRequest,
    @Body() dto: CreatorQuizDto,
  ): Promise<CreatorProfileView> {
    return this.service.createViaQuiz(req.telegramUserId, dto);
  }

  @Get('me')
  me(@Req() req: IdentifiedRequest): Promise<CreatorProfileView> {
    return this.service.getOwn(req.telegramUserId);
  }

  @Get('me/stats')
  stats(@Req() req: IdentifiedRequest): Promise<CreatorStatsView> {
    return this.service.getOwnStats(req.telegramUserId);
  }

  @Patch('me')
  update(
    @Req() req: IdentifiedRequest,
    @Body() dto: UpdateCreatorProfileDto,
  ): Promise<CreatorProfileView> {
    return this.service.updateOwn(req.telegramUserId, dto);
  }
}

@Controller('creators')
export class PublicCreatorController {
  constructor(private readonly service: CreatorProfileService) {}

  @Get()
  catalog(
    @Query('niche') niche?: string,
    @Query('priceMax') priceMax?: string,
    @Query('cursor') cursor?: string,
    @Query('pageSize') pageSize?: string,
  ): Promise<CreatorCatalogResult> {
    return this.service.listCatalog({
      niche: niche || undefined,
      priceMax: priceMax ? Number(priceMax) : undefined,
      cursor: cursor || null,
      pageSize: Math.min(Math.max(parseInt(pageSize ?? '20', 10) || 20, 1), 50),
    });
  }

  @Get(':idOrSlug')
  get(@Param('idOrSlug') idOrSlug: string): Promise<CreatorProfileView> {
    return this.service.getPublic(idOrSlug);
  }

  @Post(':idOrSlug/view')
  @HttpCode(204)
  async view(@Param('idOrSlug') idOrSlug: string): Promise<void> {
    await this.service.recordView(idOrSlug);
  }

  @Get(':id/similar')
  similar(@Param('id') id: string): Promise<SimilarCreatorView[]> {
    return this.service.getSimilar(id);
  }
}

@Controller('admin/creator-profiles')
@UseGuards(AdminSessionGuard)
export class AdminCreatorProfileController {
  constructor(
    private readonly service: CreatorProfileService,
    private readonly adminPanel: AdminPanelService,
  ) {}

  @Get()
  async list(
    @Req() req: AdminAuthenticatedRequest,
    @Query('isFeatured') isFeatured?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ): Promise<AdminCreatorProfileListResult> {
    await this.adminPanel.assertOperator(req.userId);
    return this.service.adminList({
      isFeatured: isFeatured === undefined ? undefined : isFeatured === 'true',
      page: Math.max(parseInt(page ?? '1', 10) || 1, 1),
      pageSize: Math.min(
        Math.max(parseInt(pageSize ?? '20', 10) || 20, 1),
        100,
      ),
    });
  }

  @Patch(':id/featured')
  async setFeatured(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: SetFeaturedDto,
  ): Promise<CreatorProfileView> {
    await this.adminPanel.assertOperator(req.userId);
    return this.service.adminSetFeatured(id, dto.isFeatured);
  }
}
