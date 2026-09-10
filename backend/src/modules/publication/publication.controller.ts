/**
 * User side (TelegramIdentityGuard — a channel needs an owner):
 *   POST   /sessions/:sessionId/publications              queue for moderation
 *   GET    /sessions/:sessionId/publications              this session's requests
 *   DELETE /sessions/:sessionId/publications/:requestId   withdraw while PENDING
 *
 * Operator side (AdminSessionGuard + isOperator, like the rest of /admin):
 *   GET  /admin/publications?status=&page=&pageSize=
 *   GET  /admin/publications/:id
 *   POST /admin/publications/:id/approve  { channelId?, privacy? } (§14.2/14.3, этап 61)
 *   POST /admin/publications/:id/reject   { reason }
 *   POST /admin/publications/:id/retry    FAILED → APPROVED, backoff сброшен (§14.5)
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
import { PublicationService } from './publication.service';
import {
  ApprovePublicationRequestDto,
  CreatePublicationRequestDto,
  RejectPublicationRequestDto,
} from './dto/publication.dto';
import {
  PublicationListResult,
  PublicationRequestView,
} from '../../common/types/publication.types';

@Controller('sessions/:sessionId/publications')
@UseGuards(TelegramIdentityGuard)
export class PublicationController {
  constructor(private readonly service: PublicationService) {}

  @Post()
  create(
    @Req() req: IdentifiedRequest,
    @Param('sessionId') sessionId: string,
    @Body() dto: CreatePublicationRequestDto,
  ): Promise<PublicationRequestView> {
    return this.service.create(req.telegramUserId, sessionId, dto);
  }

  @Get()
  list(
    @Req() req: IdentifiedRequest,
    @Param('sessionId') sessionId: string,
  ): Promise<PublicationRequestView[]> {
    return this.service.listForSession(req.telegramUserId, sessionId);
  }

  @Delete(':requestId')
  @HttpCode(204)
  withdraw(
    @Req() req: IdentifiedRequest,
    @Param('sessionId') sessionId: string,
    @Param('requestId') requestId: string,
  ): Promise<void> {
    return this.service.withdraw(req.telegramUserId, sessionId, requestId);
  }
}

@Controller('admin/publications')
@UseGuards(AdminSessionGuard)
export class AdminPublicationController {
  constructor(
    private readonly service: PublicationService,
    private readonly adminPanel: AdminPanelService,
  ) {}

  @Get()
  async list(
    @Req() req: AdminAuthenticatedRequest,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ): Promise<PublicationListResult> {
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
  ): Promise<PublicationRequestView> {
    await this.adminPanel.assertOperator(req.userId);
    return this.service.get(id);
  }

  @Post(':id/approve')
  async approve(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: ApprovePublicationRequestDto,
  ): Promise<PublicationRequestView> {
    await this.adminPanel.assertOperator(req.userId);
    return this.service.approve(id, req.userId, dto);
  }

  @Post(':id/reject')
  async reject(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: RejectPublicationRequestDto,
  ): Promise<PublicationRequestView> {
    await this.adminPanel.assertOperator(req.userId);
    return this.service.reject(id, req.userId, dto);
  }

  /** POST /admin/publications/:id/retry — FAILED → APPROVED, backoff сброшен (§14.5). */
  @Post(':id/retry')
  async retry(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<PublicationRequestView> {
    await this.adminPanel.assertOperator(req.userId);
    return this.service.retry(id);
  }
}
