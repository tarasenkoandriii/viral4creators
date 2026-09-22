import { Module } from '@nestjs/common';
import { GreetingMusicController } from './greeting-music.controller';
import { GreetingMusicService } from './greeting-music.service';
import { PlatformSettingsService } from '../../common/platform-settings.service';
import { StorageModule } from '../storage/storage.module';

/** Музыкальная подложка поздравления (фича №4). */
@Module({
  imports: [StorageModule],
  controllers: [GreetingMusicController],
  providers: [GreetingMusicService, PlatformSettingsService],
  exports: [GreetingMusicService],
})
export class GreetingMusicModule {}
