/**
 * PublishingChannelModule — OAuth-подключение YouTube/TikTok каналов
 * (этап 61, ТЗ §14.2/14.4). PrismaModule и PlanModule глобальные
 * (@Global()), поэтому imports пуст — тот же паттерн, что у
 * publication.module.ts.
 */

import { Module } from '@nestjs/common';
import {
  PublicPublishingChannelController,
  PublishingChannelController,
} from './publishing-channel.controller';
import { PublishingChannelService } from './publishing-channel.service';
import { GoogleOAuthService } from './google-oauth.service';
import { TiktokOAuthService } from './tiktok-oauth.service';

@Module({
  controllers: [PublishingChannelController, PublicPublishingChannelController],
  providers: [PublishingChannelService, GoogleOAuthService, TiktokOAuthService],
  exports: [PublishingChannelService, GoogleOAuthService, TiktokOAuthService],
})
export class PublishingChannelModule {}
