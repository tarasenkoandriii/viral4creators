import {
  StoryDevelopmentGuard,
  StoryPublicDisabledGuard,
} from './story-development.guard';
import { StoryVideoService } from './story-video.service';
import { FfmpegApiService } from '../postprod/ffmpeg-api.service';
import { StoryReferencesService } from './story-references.service';
import { SonioxSttClient } from '../voice/soniox-stt.client';
import { Module } from '@nestjs/common';
import { StoryGiftsService } from './story-gifts.service';
import {
  StoryGiftsController,
  PublicStoryGiftController,
  StoryRenderInputController,
} from './story-gifts.controller';
@Module({
  controllers: [
    StoryGiftsController,
    PublicStoryGiftController,
    StoryRenderInputController,
  ],
  exports: [StoryVideoService],
  providers: [
    StoryDevelopmentGuard,
    StoryPublicDisabledGuard,
    StoryVideoService,
    FfmpegApiService,
    StoryGiftsService,
    SonioxSttClient,
    StoryReferencesService,
  ],
})
export class StoryGiftsModule {}
