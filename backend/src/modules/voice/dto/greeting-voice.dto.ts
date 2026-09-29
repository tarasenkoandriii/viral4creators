import {
  IsNumber,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  Validate,
} from 'class-validator';
import { AllowedAudioMime } from './voice-upload-url-request.dto';
import { GREETING_VOICE_MAX_BYTES } from '../../../common/greeting-voice';

/**
 * POST /sessions/:sessionId/voice/upload-url — тот же двухшаговый
 * контракт, что у голосового описания товара (подписанный PUT в Blob,
 * затем расшифровка по pathname), но с потолком реплики, а не диктовки:
 * см. `GREETING_VOICE_MAX_BYTES`.
 */
export class GreetingVoiceUploadUrlRequestDto {
  @IsString()
  @MaxLength(255)
  fileName!: string;

  @IsNumber()
  @Min(1)
  @Max(GREETING_VOICE_MAX_BYTES)
  fileSize!: number;

  @IsString()
  @MaxLength(100)
  @Validate(AllowedAudioMime)
  mimeType!: string;
}

/** POST /sessions/:sessionId/voice/transcribe — запись уже в Blob. */
export class GreetingVoiceTranscribeRequestDto {
  @IsString()
  @MaxLength(512)
  @Matches(/^sessions\/[^/]+\/voice-\d+\.[a-z0-9]+$/, {
    message:
      'pathname — значение из шага voice/upload-url (sessions/<sessionId>/voice-<ts>.<ext>)',
  })
  pathname!: string;
}
