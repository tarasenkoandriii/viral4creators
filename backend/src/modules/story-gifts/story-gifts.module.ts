import {
  StoryAccessGuard,
  StoryOwnerOnlyGuard,
  StoryPublicAccessGuard,
} from './story-access.guard';
import { StoryChargesService } from './story-charges.service';
import { StoryPilotService } from './story-pilot.service';
import {
  AdminStoryPilotController,
  PublicStoryCapabilitiesController,
  StoryAccessController,
} from './story-pilot.controller';
import { StoryVideoService } from './story-video.service';
import { FfmpegApiService } from '../postprod/ffmpeg-api.service';
import { StoryReferencesService } from './story-references.service';
import { SonioxSttClient } from '../voice/soniox-stt.client';
import { Module } from '@nestjs/common';
import { StoryPublicHeadersModule } from './story-public-headers.module'; // ST3-S-06
import { StorageModule } from '../storage/storage.module'; // ST3: voice sample retention
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
    StorageModule,
    StoryPublicHeadersModule,
  ], // WP2: reference search reuses the existing quota; WP1: admin guard + operator check
  controllers: [
    StoryAccessController, // ST3: before StoryGiftsController (`access` ≠ `:id`)
    StoryReferenceLibraryController, // WP2
    StoryGiftsController,
    PublicStoryGiftController,
    StoryRenderInputController,
    AdminStoryTalesController, // WP1
    AdminStoryPilotController, // ST3
    PublicStoryCapabilitiesController, // ST3
  ],
  exports: [StoryVideoService, StoryRetentionService],
  providers: [
    StoryAccessGuard,
    StoryOwnerOnlyGuard,
    StoryPublicAccessGuard,
    StoryChargesService, // ST3
    StoryPilotService, // ST3
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
