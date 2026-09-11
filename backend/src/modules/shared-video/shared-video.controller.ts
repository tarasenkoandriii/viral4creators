/**
 * Owner side (TelegramIdentityGuard — a public page needs an owner):
 *   POST   /sessions/:sessionId/shared-video              queue for moderation
 *   GET    /sessions/:sessionId/shared-video               this session's pages
 *   DELETE /sessions/:sessionId/shared-video/:pageId       withdraw at any status
 *
 * Public side (no guard — landing + «Сделать такой же», этап 60):
 *   GET  /shared-video/feed          feed of PUBLISHED pages (этап 80, TODO §III.9)
 *   GET  /shared-video/:id           published page (bumps viewCount)
 *   POST /shared-video/:id/fork      new anonymous session, forks the analysis
 *   POST /shared-video/:id/share     best-effort +1 to shareCount (этап 80)
 *
 * Feed engagement (TelegramIdentityGuard — a like without identity is
 * meaningless, этап 80, doc/SOCIAL-FEED-SPEC.md §4):
 *   POST   /shared-video/:id/like
 *   DELETE /shared-video/:id/like
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
import { TelegramIdentifiedRequest } from '../telegram-auth/telegram-identity.middleware';
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
  SharedVideoFeedResult,
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

  /**
   * GET /shared-video/feed — ДО `:id` ниже: иначе Nest матчит статичный
   * `feed` как значение `:id` (порядок объявления маршрутов внутри
   * контроллера значим). Без гварда, но подхватывает
   * `req.telegramUserId`, если middleware её уже заполнила (initData/
   * dev-bypass/login-cookie) — не требуем identity для чтения ленты,
   * только используем её при наличии, чтобы посчитать `likedByViewer`
   * (этап 80, doc/SOCIAL-FEED-SPEC.md §4).
   */
  @Get('feed')
  feed(
    @Req() req: TelegramIdentifiedRequest,
    @Query('cursor') cursor?: string,
    @Query('pageSize') pageSize?: string,
  ): Promise<SharedVideoFeedResult> {
    return this.service.listFeed({
      cursor: cursor || null,
      pageSize: Math.min(Math.max(parseInt(pageSize ?? '20', 10) || 20, 1), 50),
      viewerUserId: req.telegramUserId ?? null,
    });
  }

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

  /**
   * POST /shared-video/:id/share — этап 80: best-effort +1 к
   * `shareCount`, тот же паттерн, что бамп `viewCount` в `getPublic()`.
   * Вызывается и из ленты, и из `ShareVideoPanel` (владелец делится
   * собственным роликом) — один счётчик, две точки входа.
   */
  @Post(':id/share')
  @HttpCode(204)
  async share(@Param('id') id: string): Promise<void> {
    await this.service.recordShare(id);
  }
}

/**
 * Лайк ленты (этап 80, TODO §III.9) — требует identity: лайк без
 * личности не имеет смысла (антинакрутка, doc/SOCIAL-FEED-SPEC.md §3.2).
 * Отдельный контроллер, а не гвард на пару методов `PublicSharedVideoController`
 * выше — тот целиком открыт, смешивать гвард на части одного класса
 * менее явно, чем отдельный класс с собственным `@UseGuards`.
 */
@Controller('shared-video')
@UseGuards(TelegramIdentityGuard)
export class SharedVideoLikeController {
  constructor(private readonly service: SharedVideoService) {}

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
