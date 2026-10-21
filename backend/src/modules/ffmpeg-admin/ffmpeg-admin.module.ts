import { Module } from '@nestjs/common';
import { AdminAuthModule } from '../admin-auth/admin-auth.module';
import { FfmpegAdminAccess } from './ffmpeg-admin-access';
import { FfmpegAdminController } from './ffmpeg-admin.controller';
import { FfmpegAdminService } from './ffmpeg-admin.service';
import { FfmpegOperatorJournal } from './ffmpeg-operator-journal';
import { FfmpegOpsClient } from './ffmpeg-ops.client';

/**
 * Вкладка «FFmpeg» админки (ТЗ FFmpeg-server v1.1 §13.1): прокси к
 * собственному ffmpeg-server, маршрутизация hosted|selfhosted и журнал
 * оператора. `FfmpegApiService` — из глобального `PostProductionModule`,
 * Prisma — глобальна.
 */
@Module({
  imports: [AdminAuthModule],
  controllers: [FfmpegAdminController],
  providers: [
    FfmpegAdminService,
    FfmpegAdminAccess,
    FfmpegOperatorJournal,
    FfmpegOpsClient,
  ],
  // Дашборд внимания читает ту же сводку (правило FFmpeg).
  exports: [FfmpegAdminService],
})
export class FfmpegAdminModule {}
