import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { VoiceController } from './voice.controller';
import { VoiceService } from './voice.service';
import { VoiceTranscriptionService } from './voice-transcription.service';

/**
 * VoiceModule — spoken product description → text via Gemini audio
 * (doc/PRODUCT-PROJECT-SPEC.md §6.2; Stage 5). Reuses GEMINI_API_KEY and
 * the Blob presigned-upload flow; no new secret, no new dependency.
 */
@Module({
  imports: [StorageModule],
  controllers: [VoiceController],
  providers: [VoiceService, VoiceTranscriptionService],
})
export class VoiceModule {}
