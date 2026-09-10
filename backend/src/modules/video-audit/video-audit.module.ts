import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { GeminiFilesService } from '../analysis/gemini-files.service';
import {
  SoundCheckController,
  VideoAuditController,
} from './video-audit.controller';
import { VideoAuditService } from './video-audit.service';

/**
 * VideoAuditModule — post-generation artefact audit (spec §11, Stage 16)
 * plus the voice-realism sound check (этап 73, `common/sound-check.ts`) —
 * same service, same Gemini plumbing, two controllers.
 * Reuses GeminiFilesService from analysis (same Files-API upload path).
 */
@Module({
  imports: [StorageModule],
  controllers: [VideoAuditController, SoundCheckController],
  providers: [VideoAuditService, GeminiFilesService],
  exports: [VideoAuditService],
})
export class VideoAuditModule {}
