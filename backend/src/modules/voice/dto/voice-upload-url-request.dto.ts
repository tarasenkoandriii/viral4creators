import {
  IsNumber,
  IsString,
  Max,
  MaxLength,
  Min,
  Validate,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import {
  ALLOWED_AUDIO_MIME,
  MAX_AUDIO_BYTES,
  baseMime,
} from '../voice-transcription.service';

/**
 * MediaRecorder reports MIME types WITH codec parameters
 * ("audio/webm;codecs=opus"), so a plain @IsIn on the full string would
 * reject every real browser recording. Compare the base type instead.
 */
@ValidatorConstraint({ name: 'allowedAudioMime', async: false })
class AllowedAudioMime implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return (
      typeof value === 'string' &&
      (ALLOWED_AUDIO_MIME as readonly string[]).includes(baseMime(value))
    );
  }
  defaultMessage(): string {
    return `mimeType must be one of ${ALLOWED_AUDIO_MIME.join(', ')} (codec parameters allowed)`;
  }
}

/** POST /projects/:id/items/:itemId/voice/upload-url — same contract as the photo/product-image step. */
export class VoiceUploadUrlRequestDto {
  @IsString()
  @MaxLength(255)
  fileName!: string;

  @IsNumber()
  @Min(1)
  @Max(MAX_AUDIO_BYTES)
  fileSize!: number;

  @IsString()
  @MaxLength(100)
  @Validate(AllowedAudioMime)
  mimeType!: string;
}
