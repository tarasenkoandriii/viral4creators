import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDefined,
  IsIn,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  Validate,
  ValidateNested,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { AllowedAudioMime } from './voice-upload-url-request.dto';
import { GREETING_VOICE_MAX_BYTES } from '../../../common/greeting-voice';
import {
  VOICE_MESSAGE_MAX,
  VOICE_SCREEN_STEPS,
  VoiceScreenStep,
} from '../../../common/greeting-voice-intent';

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

// ── Разбор реплики (этап K3) ────────────────────────────────────────────

/** Значение поля карточки: строка (до потолка текста брифа) или галочка. */
@ValidatorConstraint({ name: 'voiceFieldValue', async: false })
export class VoiceFieldValue implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return (
      typeof value === 'boolean' ||
      (typeof value === 'string' && value.length <= VOICE_MESSAGE_MAX)
    );
  }
  defaultMessage(): string {
    return `value — строка до ${VOICE_MESSAGE_MAX} символов или true/false`;
  }
}

export class VoiceScreenDto {
  @IsIn([...VOICE_SCREEN_STEPS])
  step!: VoiceScreenStep;

  /** `data-qa` карточки в фокусе. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  card?: string;
}

export class VoicePendingFieldDto {
  @IsString()
  @MaxLength(100)
  target!: string;

  @Validate(VoiceFieldValue)
  value!: string | boolean;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  label?: string;
}

/** Карточка «я понял так» на экране — чтобы «да»/«нет»/«исправь имя» читались как ответ на неё. */
export class VoicePendingDto {
  @IsIn(['fill'])
  kind!: 'fill';

  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => VoicePendingFieldDto)
  fields!: VoicePendingFieldDto[];
}

/** Общая часть запроса understand — экран и карточка на нём. */
class VoiceUnderstandBodyDto {
  // `ValidateNested` пропускает отсутствующее поле — экран обязателен явно.
  @IsDefined()
  @ValidateNested()
  @Type(() => VoiceScreenDto)
  screen!: VoiceScreenDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => VoicePendingDto)
  pending?: VoicePendingDto;

  /**
   * Значения полей брифа НА ЭКРАНЕ, ещё не сохранённые (изменение
   * контракта 1 финального аудита ветки K): `{ occasion?, mood?, tone?,
   * … }`, строки или `null`. Здесь проверяется только форма — объект;
   * каждое значение сервис проверяет правилами DTO брифа
   * (`overlayCurrentBrief`), и неверное поле ИГНОРИРУЕТСЯ, а не валит
   * запрос: одно испорченное значение не должно стоить человеку реплики.
   */
  @IsOptional()
  @IsObject()
  current?: Record<string, unknown>;
}

/** POST /sessions/:sessionId/voice/understand — запись уже в Blob (upload-url K2). */
export class GreetingVoiceUnderstandRequestDto extends VoiceUnderstandBodyDto {
  @IsString()
  @MaxLength(512)
  @Matches(/^sessions\/[^/]+\/voice-\d+\.[a-z0-9]+$/, {
    message:
      'pathname — значение из шага voice/upload-url (sessions/<sessionId>/voice-<ts>.<ext>)',
  })
  pathname!: string;
}

/**
 * POST /projects/:projectId/greeting-voice/understand — бриф ДО сессии:
 * запись лежит под префиксом проекта (`greeting-voice/upload-url`).
 */
export class ProjectGreetingVoiceUnderstandRequestDto extends VoiceUnderstandBodyDto {
  @IsString()
  @MaxLength(512)
  @Matches(/^projects\/[^/]+\/greeting-voice-\d+\.[a-z0-9]+$/, {
    message:
      'pathname — значение из шага greeting-voice/upload-url (projects/<projectId>/greeting-voice-<ts>.<ext>)',
  })
  pathname!: string;
}
