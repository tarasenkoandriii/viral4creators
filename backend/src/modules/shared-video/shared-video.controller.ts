/**
 * Owner side (TelegramIdentityGuard — a public page needs an owner):
 *   POST   /sessions/:sessionId/shared-video              queue for moderation
 *   GET    /sessions/:sessionId/shared-video               this session's pages
 *   DELETE /sessions/:sessionId/shared-video/:pageId       withdraw at any status
 *
 * Public side (no guard — landing + «Сделать такой же», этап 60):
 *   GET  /shared-video/:id           published page (bumps viewCount)
 *   POST /shared-video/:id/fork      new anonymous session, forks the analysis
 *
 * Operator side (AdminSessionGuard + isOperator, like the rest of /admin):
 *   GET  /admin/shared-videos?status=&page=&pageSize=
 *   GET  /admin/shared-videos/:id
 *   POST /admin/shared-videos/:id/approve
 *   POST /admin/shared-videos/:id/reject   { reason }
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
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
import {
  AdminAuthenticatedRequest,
  AdminSessionGuard,
} from '../admin-auth/admin-session.guard';
import { AdminPanelService } from '../admin-panel/admin-panel.service';
import { SharedVideoService } from './shared-video.service';
import {
  CreateSharedVideoRequestDto,
  ForkSharedVideoRequestDto,
  RejectSharedVideoRequestDto,
} from './dto/shared-video.dto';
import {
  SharedVideoListResult,
  SharedVideoPageView,
  SharedVideoPublicView,
} from '../../common/types/shared-video.types';

@Controller('sessions/:sessionId/shared-video')
@UseGuards(TelegramIdentityGuard)
export class SharedVideoController {
  constructor(private readonly service: SharedVideoService) {}

  @Post()
  create(
    @Req() req: IdentifiedRequest,
    @Param('sessionId') sessionId: string,
    @Body() dto: CreateSharedVideoRequestDto,
  ): Promise<SharedVideoPageView> {
    return this.service.create(req.telegramUserId, sessionId, dto);
  }

  @Get()
  list(
    @Req() req: IdentifiedRequest,
    @Param('sessionId') sessionId: string,
  ): Promise<SharedVideoPageView[]> {
    return this.service.listForSession(req.telegramUserId, sessionId);
  }

  @Delete(':pageId')
  @HttpCode(204)
  withdraw(
    @Req() req: IdentifiedRequest,
    @Param('sessionId') sessionId: string,
    @Param('pageId') pageId: string,
  ): Promise<void> {
    return this.service.withdraw(req.telegramUserId, sessionId, pageId);
  }
}

/**
 * Публичный контроллер: без гварда и без `:sessionId` в пути, значит и
 * `SessionOwnerGuard` (глобальный, но реагирует только на `:sessionId`)
 * тут ни при чём — маршрут открыт всем, это и есть его назначение.
 */
@Controller('shared-video')
export class PublicSharedVideoController {
  constructor(private readonly service: SharedVideoService) {}

  @Get(':id')
  get(@Param('id') id: string): Promise<SharedVideoPublicView> {
    return this.service.getPublic(id);
  }

  @Post(':id/fork')
  fork(
    @Param('id') id: string,
    @Body() dto: ForkSharedVideoRequestDto,
  ): Promise<{ sessionId: string }> {
    return this.service.fork(id, dto);
  }
}

@Controller('admin/shared-videos')
@UseGuards(AdminSessionGuard)
export class AdminSharedVideoController {
  constructor(
    private readonly service: SharedVideoService,
    private readonly adminPanel: AdminPanelService,
  ) {}

  @Get()
  async list(
    @Req() req: AdminAuthenticatedRequest,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ): Promise<SharedVideoListResult> {
    await this.adminPanel.assertOperator(req.userId);
    return this.service.list({
      status,
      page: Math.max(parseInt(page ?? '1', 10) || 1, 1),
      pageSize: Math.min(
        Math.max(parseInt(pageSize ?? '20', 10) || 20, 1),
        100,
      ),
    });
  }

  @Get(':id')
  async get(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<SharedVideoPageView> {
    await this.adminPanel.assertOperator(req.userId);
    return this.service.get(id);
  }

  @Post(':id/approve')
  async approve(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<SharedVideoPageView> {
    await this.adminPanel.assertOperator(req.userId);
    return this.service.approve(id, req.userId);
  }

  @Post(':id/reject')
  async reject(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: RejectSharedVideoRequestDto,
  ): Promise<SharedVideoPageView> {
    await this.adminPanel.assertOperator(req.userId);
    return this.service.reject(id, req.userId, dto);
  }
}
