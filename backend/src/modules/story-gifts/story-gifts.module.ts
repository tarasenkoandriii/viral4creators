import { SonioxSttClient } from '../voice/soniox-stt.client';
import { Module } from '@nestjs/common';
import { StoryGiftsService } from './story-gifts.service';
import {
  StoryGiftsController,
  PublicStoryGiftController,
} from './story-gifts.controller';
@Module({
  controllers: [StoryGiftsController, PublicStoryGiftController],
  providers: [StoryGiftsService, SonioxSttClient],
})
export class StoryGiftsModule {}
