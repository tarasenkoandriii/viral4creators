import { Module } from '@nestjs/common';
import { YoutubeSearchController } from './youtube-search.controller';
import { YoutubeSearchService } from './youtube-search.service';
import { YoutubeSearchUsageService } from './youtube-search-usage.service';

/**
 * YoutubeSearchModule — reference-video search (spec §6.4/§9, Stage 11).
 * Finds the link; handing it to the analysis flow is the existing
 * POST /sessions/:id/video/youtube (modules/video), untouched.
 */
@Module({
  controllers: [YoutubeSearchController],
  providers: [YoutubeSearchService, YoutubeSearchUsageService],
  exports: [YoutubeSearchService],
})
export class YoutubeSearchModule {}
