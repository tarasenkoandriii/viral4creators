/**
 * Own side (TelegramIdentityGuard):
 *   POST   /portfolio-items          self-upload, требует свой CreatorProfile
 *   GET    /portfolio-items/mine     свои работы, любой статус
 *   PATCH  /portfolio-items/:id      сейчас — только подборка (§20 №20)
 *   DELETE /portfolio-items/:id      отозвать в любом статусе
 *
 * Public side (no guard — витрина открыта без входа, ТЗ §9, §20):
 *   GET  /creators/:creatorProfileId/portfolio   PUBLISHED-грид профиля
 *   GET  /portfolio-items/feed                   лента для RSS/JSON (№11)
 *   GET  /portfolio-items/collections            список подборок (№20)
 *   GET  /portfolio-items/collections/:tag       работы подборки (№20)
 *   GET  /portfolio-items/:id                    одна карточка
 *   GET  /portfolio-items/:id/similar            похожие работы (№17)
 *   POST /portfolio-items/:id/view               счётчик просмотров (№13)
 *
 * Like (TelegramIdentityGuard — лайк без identity бессмысленен, §11.1):
 *   POST/DELETE /portfolio-items/:id/like
 *
 * Admin (AdminSessionGuard, по образцу AdminSharedVideoController):
 *   GET  /admin/portfolio-items?status=&page=&pageSize=
 *   POST /admin/portfolio-items/:id/approve
 *   POST /admin/portfolio-items/:id/reject   { reason }
 *   POST /admin/portfolio-items/broadcast-top-of-week   §20 №8, ручной триггер
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
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  IdentifiedRequest,
  TelegramIdentityGuard,
} from '../telegram-auth/telegram-identity.guard';
import { TelegramIdentifiedRequest } from '../telegram-auth/telegram-identity.middleware';
import {
  AdminAuthenticatedRequest,
  AdminSessionGuard,
} from '../admin-auth/admin-session.guard';
import { AdminPanelService } from '../admin-panel/admin-panel.service';
import { PortfolioService } from './portfolio.service';
import {
  CreatePortfolioItemDto,
  RejectPortfolioItemDto,
  UpdatePortfolioItemDto,
} from './dto/portfolio.dto';
import {
  AdminPortfolioListResult,
  PortfolioCollectionSummaryView,
  PortfolioFeedItemView,
  PortfolioItemView,
  SimilarPortfolioItemView,
} from '../../common/types/marketplace.types';

@Controller('portfolio-items')
@UseGuards(TelegramIdentityGuard)
export class PortfolioController {
  constructor(private readonly service: PortfolioService) {}

  @Post()
  create(
    @Req() req: IdentifiedRequest,
    @Body() dto: CreatePortfolioItemDto,
  ): Promise<PortfolioItemView> {
    return this.service.create(req.telegramUserId, dto);
  }

  @Get('mine')
  mine(@Req() req: IdentifiedRequest): Promise<PortfolioItemView[]> {
    return this.service.listMine(req.telegramUserId);
  }

  @Patch(':id')
  update(
    @Req() req: IdentifiedRequest,
    @Param('id') id: string,
    @Body() dto: UpdatePortfolioItemDto,
  ): Promise<PortfolioItemView> {
    return this.service.updateOwn(req.telegramUserId, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  withdraw(
    @Req() req: IdentifiedRequest,
    @Param('id') id: string,
  ): Promise<void> {
    return this.service.withdraw(req.telegramUserId, id);
  }
}

@Controller()
export class PublicPortfolioController {
  constructor(private readonly service: PortfolioService) {}

  @Get('creators/:creatorProfileId/portfolio')
  listForCreator(
    @Req() req: TelegramIdentifiedRequest,
    @Param('creatorProfileId') creatorProfileId: string,
  ): Promise<PortfolioItemView[]> {
    return this.service.listPublicForCreator(
      creatorProfileId,
      req.telegramUserId ?? null,
    );
  }

  // Статичные пути ДО ':id' ниже — иначе Nest матчит 'feed'/'collections' как значение :id.

  @Get('portfolio-items/feed')
  feed(@Query('limit') limit?: string): Promise<PortfolioFeedItemView[]> {
    return this.service.getFeed(
      Math.min(Math.max(parseInt(limit ?? '30', 10) || 30, 1), 100),
    );
  }

  @Get('portfolio-items/collections')
  collections(): Promise<PortfolioCollectionSummaryView[]> {
    return this.service.listCollections();
  }

  @Get('portfolio-items/collections/:tag')
  collectionItems(@Param('tag') tag: string): Promise<PortfolioItemView[]> {
    return this.service.listByCollection(tag);
  }

  @Get('portfolio-items/:id')
  get(
    @Req() req: TelegramIdentifiedRequest,
    @Param('id') id: string,
  ): Promise<PortfolioItemView> {
    return this.service.getPublic(id, req.telegramUserId ?? null);
  }

  @Get('portfolio-items/:id/similar')
  similar(@Param('id') id: string): Promise<SimilarPortfolioItemView[]> {
    return this.service.getSimilar(id);
  }

  @Post('portfolio-items/:id/view')
  @HttpCode(204)
  async view(@Param('id') id: string): Promise<void> {
    await this.service.recordView(id);
  }
}

@Controller('portfolio-items')
@UseGuards(TelegramIdentityGuard)
export class PortfolioLikeController {
  constructor(private readonly service: PortfolioService) {}

  @Post(':id/like')
  like(
    @Req() req: IdentifiedRequest,
    @Param('id') id: string,
  ): Promise<{ likeCount: number; likedByViewer: boolean }> {
    return this.service.like(req.telegramUserId, id);
  }

  @Delete(':id/like')
  unlike(
    @Req() req: IdentifiedRequest,
    @Param('id') id: string,
  ): Promise<{ likeCount: number; likedByViewer: boolean }> {
    return this.service.unlike(req.telegramUserId, id);
  }
}

@Controller('admin/portfolio-items')
@UseGuards(AdminSessionGuard)
export class AdminPortfolioController {
  constructor(
    private readonly service: PortfolioService,
    private readonly adminPanel: AdminPanelService,
  ) {}

  @Get()
  async list(
    @Req() req: AdminAuthenticatedRequest,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ): Promise<AdminPortfolioListResult> {
    await this.adminPanel.assertOperator(req.userId);
    return this.service.adminList({
      status,
      page: Math.max(parseInt(page ?? '1', 10) || 1, 1),
      pageSize: Math.min(
        Math.max(parseInt(pageSize ?? '20', 10) || 20, 1),
        100,
      ),
    });
  }

  @Post(':id/approve')
  async approve(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<PortfolioItemView> {
    await this.adminPanel.assertOperator(req.userId);
    return this.service.adminApprove(id, req.userId);
  }

  @Post(':id/reject')
  async reject(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: RejectPortfolioItemDto,
  ): Promise<PortfolioItemView> {
    await this.adminPanel.assertOperator(req.userId);
    return this.service.adminReject(id, req.userId, dto);
  }

  @Post('broadcast-top-of-week')
  async broadcastTopOfWeek(
    @Req() req: AdminAuthenticatedRequest,
  ): Promise<{ sent: boolean; count: number }> {
    await this.adminPanel.assertOperator(req.userId);
    return this.service.adminBroadcastTopOfWeek();
  }
}
