/**
 * Two small REST surfaces of Stage 10:
 *
 *   POST /projects/:projectId/items/:itemId/sessions   start a Session from an item
 *   GET  /projects/:projectId/items/:itemId/sessions   that item's runs (history)
 *   PATCH /sessions/:sessionId/brand-manifest          edit the session's manifest copy
 *
 * The first two live under /projects and therefore behind
 * TelegramIdentityGuard (a catalog has an owner). The PATCH follows the
 * existing /sessions convention: the session UUID is the bearer secret,
 * no identity required — the anonymous wizard must keep working, and a
 * session with a snapshot can only exist if its owner created it via the
 * guarded route above.
 */

import {
  Body,
  Controller,
  Get,
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
import { Session } from '../../common/types/session.types';
import { BrandManifestSnapshot } from '../../common/types/brand-manifest.types';
import {
  ItemSessionSummary,
  ProjectSessionService,
} from './project-session.service';
import { UpdateBrandSnapshotRequestDto } from './dto/update-brand-snapshot.dto';
import { CreateSessionFromItemRequestDto } from './dto/create-session-from-item.dto';

@Controller('projects/:projectId/items/:itemId/sessions')
@UseGuards(TelegramIdentityGuard)
export class ProjectSessionController {
  constructor(private readonly service: ProjectSessionService) {}

  /** Same response shape as POST /sessions so the wizard can reuse it. */
  @Post()
  async create(
    @Req() req: IdentifiedRequest,
    @Param('projectId') projectId: string,
    @Param('itemId') itemId: string,
    @Body() dto: CreateSessionFromItemRequestDto,
  ): Promise<{ sessionId: string; session: Session }> {
    const session = await this.service.createFromItem(
      req.telegramUserId,
      projectId,
      itemId,
      dto?.locale,
    );
    return { sessionId: session.sessionId, session };
  }

  @Get()
  list(
    @Req() req: IdentifiedRequest,
    @Param('projectId') projectId: string,
    @Param('itemId') itemId: string,
  ): Promise<ItemSessionSummary[]> {
    return this.service.listForItem(req.telegramUserId, projectId, itemId);
  }
}

/**
 * GREETING_VIDEO counterpart of ProjectSessionController above — no
 * ProductItem for this project type, so the Session starts from the
 * project's GreetingBrief instead (ТЗ TZ-Greeting-Video-Project-Type.md
 * §4.3, see ProjectSessionService.createFromGreetingBrief doc-comment for
 * why this route exists even though §8's endpoint table doesn't list it).
 */
@Controller('projects/:projectId/greeting-brief/sessions')
@UseGuards(TelegramIdentityGuard)
export class GreetingBriefSessionController {
  constructor(private readonly service: ProjectSessionService) {}

  @Post()
  async create(
    @Req() req: IdentifiedRequest,
    @Param('projectId') projectId: string,
    @Body() dto: CreateSessionFromItemRequestDto,
  ): Promise<{ sessionId: string; session: Session }> {
    const session = await this.service.createFromGreetingBrief(
      req.telegramUserId,
      projectId,
      dto?.locale,
    );
    return { sessionId: session.sessionId, session };
  }

  @Get()
  list(
    @Req() req: IdentifiedRequest,
    @Param('projectId') projectId: string,
  ): Promise<ItemSessionSummary[]> {
    return this.service.listForGreetingBrief(req.telegramUserId, projectId);
  }
}

@Controller('sessions/:sessionId/brand-manifest')
export class SessionBrandManifestController {
  constructor(private readonly service: ProjectSessionService) {}

  @Patch()
  update(
    @Param('sessionId') sessionId: string,
    @Body() dto: UpdateBrandSnapshotRequestDto,
  ): Promise<BrandManifestSnapshot> {
    return this.service.updateSnapshot(sessionId, dto);
  }
}
