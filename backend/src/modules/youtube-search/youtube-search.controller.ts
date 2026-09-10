/**
 *   GET /youtube-search?q=...&regionCode=UA&language=uk
 *
 * Behind TelegramIdentityGuard: the per-user daily cap needs a user, and
 * the Google quota is shared by the whole deployment — an anonymous
 * caller could exhaust it for everyone. The anonymous quick path keeps
 * its two other ways in (spec §9.2): paste a link, upload a file.
 */

import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import {
  IdentifiedRequest,
  TelegramIdentityGuard,
} from '../telegram-auth/telegram-identity.guard';
import { YoutubeSearchService } from './youtube-search.service';
import { YoutubeSearchQueryDto } from './dto/youtube-search-query.dto';
import { YoutubeSearchResponse } from './youtube-search.types';

@Controller('youtube-search')
@UseGuards(TelegramIdentityGuard)
export class YoutubeSearchController {
  constructor(private readonly service: YoutubeSearchService) {}

  @Get()
  search(
    @Req() req: IdentifiedRequest,
    @Query() dto: YoutubeSearchQueryDto,
  ): Promise<YoutubeSearchResponse> {
    return this.service.search(req.telegramUserId, dto.q, {
      regionCode: dto.regionCode,
      language: dto.language,
    });
  }
}
