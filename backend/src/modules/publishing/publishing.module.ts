/**
 * PublishingModule — выгрузка одобренных заявок в YouTube/TikTok (этап
 * 61, ТЗ §14.5): загрузочные клиенты + крон-воркер. Зависит от
 * PublishingChannelModule (`ensureFreshToken`) — импортирует его явно,
 * а не полагается на глобальность (PublishingChannelService не
 * `@Global()`, в отличие от Prisma/Plan).
 */

import { Module } from '@nestjs/common';
import { PublishingChannelModule } from '../publishing-channel/publishing-channel.module';
import { YoutubeUploadService } from './youtube-upload.service';
import { TiktokUploadService } from './tiktok-upload.service';
import { PublishWorkerService } from './publish-worker.service';
import { PublicationTranslationService } from './publication-translation.service';
import { AudioTrackService } from './audio-track.service';
import { YoutubeCaptionsService } from './youtube-captions.service';
import { AdminAudioTracksService } from './admin-audio-tracks.service';
import { AdminAudioTracksController } from './admin-audio-tracks.controller';
import { UserAudioTracksService } from './user-audio-tracks.service';
import { UserAudioTracksController } from './user-audio-tracks.controller';
import { AdminAuthModule } from '../admin-auth/admin-auth.module';
import { AdminPanelModule } from '../admin-panel/admin-panel.module';
import { TtsModule } from '../tts/tts.module';
import { StorageModule } from '../storage/storage.module';

@Module({
  // `AdminAuthModule`/`AdminPanelModule` — ради экрана передачи
  // дорожек оператору (этап 139): admin-контроллер конкретной фичи
  // живёт в модуле этой фичи и импортирует админку сам, а не наоборот
  // (см. комментарий в `admin-panel.module.ts`).
  imports: [
    PublishingChannelModule,
    TtsModule,
    StorageModule,
    AdminAuthModule,
    AdminPanelModule,
  ],
  controllers: [AdminAudioTracksController, UserAudioTracksController],
  providers: [
    YoutubeUploadService,
    TiktokUploadService,
    PublishWorkerService,
    PublicationTranslationService,
    AudioTrackService,
    AdminAudioTracksService,
    YoutubeCaptionsService,
    UserAudioTracksService,
  ],
  exports: [PublishWorkerService, AudioTrackService],
})
export class PublishingModule {}
