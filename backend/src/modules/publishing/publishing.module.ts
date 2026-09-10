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

@Module({
  imports: [PublishingChannelModule],
  providers: [YoutubeUploadService, TiktokUploadService, PublishWorkerService],
  exports: [PublishWorkerService],
})
export class PublishingModule {}
