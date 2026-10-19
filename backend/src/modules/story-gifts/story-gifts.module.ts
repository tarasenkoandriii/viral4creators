import {
  StoryDevelopmentGuard,
  StoryPublicDisabledGuard,
} from './story-development.guard';
import { StoryVideoService } from './story-video.service';
import { FfmpegApiService } from '../postprod/ffmpeg-api.service';
import { StoryReferencesService } from './story-references.service';
import { SonioxSttClient } from '../voice/soniox-stt.client';
import { Module } from '@nestjs/common';
import { AdminPanelModule } from '../admin-panel/admin-panel.module';
import { AdminAuthModule } from '../admin-auth/admin-auth.module';
import { AdminStoryTalesController } from './story-operator.controller';
import { StoryOperatorService } from './story-operator.service';
import { StoryRetentionService } from './story-retention.service';
import { StoryReferenceLibraryController } from './story-reference-library.controller'; // WP2
import { YoutubeSearchModule } from '../youtube-search/youtube-search.module'; // WP2
import { BrandManifestModule } from '../brand-manifest/brand-manifest.module'; // WP5↔WP4: narrator image
import { StoryGiftsService } from './story-gifts.service';
import {
  StoryGiftsController,
  PublicStoryGiftController,
  StoryRenderInputController,
} from './story-gifts.controller';
@Module({
  imports: [
    YoutubeSearchModule,
    AdminPanelModule,
    AdminAuthModule,
    BrandManifestModule,
  ], // WP2: reference search reuses the existing quota; WP1: admin guard + operator check
  controllers: [
    StoryReferenceLibraryController, // WP2
    StoryGiftsController,
    PublicStoryGiftController,
    StoryRenderInputController,
    AdminStoryTalesController, // WP1
  ],
  exports: [StoryVideoService, StoryRetentionService],
  providers: [
    StoryDevelopmentGuard,
    StoryPublicDisabledGuard,
    StoryVideoService,
    FfmpegApiService,
    StoryGiftsService,
    SonioxSttClient,
    StoryReferencesService,
    StoryOperatorService, // WP1
    StoryRetentionService, // WP1
  ],
})
export class StoryGiftsModule {}
