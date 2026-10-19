import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  Patch,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  IdentifiedRequest,
  TelegramIdentityGuard,
} from '../telegram-auth/telegram-identity.guard';
import { StoryDevelopmentGuard } from './story-development.guard';
import { StoryReferencesService } from './story-references.service';
import {
  StoryReferenceLinkDto,
  StoryReferencePlanQuery,
  StoryReferenceSearchQuery,
} from './story-reference.dto';

/**
 * Reference library outside the wizard (TODO 9949/9952). Owner-only like the
 * rest of Story‑Tales. Every route has ≥2 path segments under
 * `story-gifts/references`, so StoryGiftsController's `:id` never shadows it;
 * `GET story-gifts/references` (list) stays in StoryGiftsController.
 */
@Controller('story-gifts/references')
@UseGuards(TelegramIdentityGuard, StoryDevelopmentGuard)
export class StoryReferenceLibraryController {
  constructor(private readonly references: StoryReferencesService) {}
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Robots-Tag', 'noindex, nofollow, noarchive')
  @Get('quota')
  quota(@Req() req: IdentifiedRequest) {
    return this.references.quota(req.telegramUserId);
  }
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Robots-Tag', 'noindex, nofollow, noarchive')
  @Get('youtube')
  youtube(
    @Req() req: IdentifiedRequest,
    @Query() q: StoryReferenceSearchQuery,
  ) {
    return this.references.search(req.telegramUserId, q.q, q.language);
  }
  @Patch(':videoId') link(
    @Req() req: IdentifiedRequest,
    @Param('videoId') videoId: string,
    @Body() dto: StoryReferenceLinkDto,
  ) {
    return this.references.link(
      req.telegramUserId,
      videoId,
      dto.editionId ?? null,
    );
  }
  @Delete(':videoId') remove(
    @Req() req: IdentifiedRequest,
    @Param('videoId') videoId: string,
  ) {
    return this.references.remove(req.telegramUserId, videoId);
  }
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Robots-Tag', 'noindex, nofollow, noarchive')
  @Get(':videoId/plan')
  plan(
    @Req() req: IdentifiedRequest,
    @Param('videoId') videoId: string,
    @Query() q: StoryReferencePlanQuery,
  ) {
    return this.references.stagingPlan(req.telegramUserId, videoId, q);
  }
}
