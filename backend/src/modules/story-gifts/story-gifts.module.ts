import { StoryReferencesService } from './story-references.service';
import { SonioxSttClient } from '../voice/soniox-stt.client';
import { Module } from '@nestjs/common';
import { StoryGiftsService } from './story-gifts.service';
import {
  StoryGiftsController,
  PublicStoryGiftController,
} from './story-gifts.controller';
@Module({
  controllers: [StoryGiftsController, PublicStoryGiftController],
  providers: [StoryGiftsService, SonioxSttClient, StoryReferencesService],
})
export class StoryGiftsModule {}
