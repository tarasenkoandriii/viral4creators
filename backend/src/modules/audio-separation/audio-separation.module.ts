/**
 * Модуль разделения звуковой дорожки (ТЗ
 * `docs-tz/TZ-Voice-Replace-Keep-Background.md`, этап B).
 *
 * Отдельный модуль, а не сервис внутри `PostprodModule`, по той же
 * причине, по которой отдельно живёт TTS: провайдер сменный, у него
 * свой контракт, и постпрод должен зависеть от контракта, а не от
 * конкретного Replicate.
 */
import { Module } from '@nestjs/common';
import { ReplicateSeparationService } from './replicate-separation.service';

@Module({
  providers: [ReplicateSeparationService],
  exports: [ReplicateSeparationService],
})
export class AudioSeparationModule {}
