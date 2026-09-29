import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { VoiceController } from './voice.controller';
import { VoiceService } from './voice.service';
import { VoiceTranscriptionService } from './voice-transcription.service';
import { GreetingVoiceController } from './greeting-voice.controller';
import { GreetingVoiceService } from './greeting-voice.service';
import { SonioxSttClient } from './soniox-stt.client';

/**
 * VoiceModule — spoken product description → text via Gemini audio
 * (doc/PRODUCT-PROJECT-SPEC.md §6.2; Stage 5). Reuses GEMINI_API_KEY and
 * the Blob presigned-upload flow; no new secret, no new dependency.
 *
 * С этапа K2 ТЗ Greeting 2.0 — и голосовая реплика в мастере
 * поздравления (`GreetingVoiceController`). Провайдер распознавания —
 * настройка админки: Gemini (звук внутри запроса, `inlineData`) или
 * Soniox (`SonioxSttClient`: файл у провайдера удаляется сразу после
 * расшифровки). Правило для записи одно на оба пути — Условия, пункт 3.4.
 */
@Module({
  imports: [StorageModule],
  controllers: [VoiceController, GreetingVoiceController],
  providers: [
    VoiceService,
    VoiceTranscriptionService,
    GreetingVoiceService,
    SonioxSttClient,
  ],
  exports: [SonioxSttClient],
})
export class VoiceModule {}
