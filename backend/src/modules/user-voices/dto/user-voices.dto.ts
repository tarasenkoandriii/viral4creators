import {
  IsBoolean,
  IsIn,
  IsNumber,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/**
 * Presigned-Blob поток, тот же приём, что у фото персонажа/сцены бренда
 * (`brand-manifest/dto/character-photo.dto.ts`) и сцен-референсов
 * (`reference-assets/dto/reference-assets.dto.ts`) — здесь тело записи
 * голоса вместо изображения. Форматы — то, что реально отдаёт браузерная
 * запись (`audio/webm`, `MediaRecorder` по умолчанию в большинстве
 * браузеров) плюс распространённые форматы файла, который могли
 * загрузить готовым.
 */
const ALLOWED_MIME_TYPES = [
  'audio/mpeg',
  'audio/wav',
  'audio/x-wav',
  'audio/mp4',
  'audio/webm',
] as const;

export class VoiceSampleUploadUrlRequestDto {
  @IsString()
  @MaxLength(255)
  fileName!: string;

  @IsNumber()
  @Min(1)
  @Max(15 * 1024 * 1024) // 15MB — с большим запасом над «минутой речи» (§5.2б TTS-спека)
  fileSize!: number;

  @IsString()
  @IsIn(ALLOWED_MIME_TYPES)
  mimeType!: string;
}

const EXT_BY_MIME: Readonly<Record<string, string>> = {
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/mp4': 'm4a',
  'audio/webm': 'webm',
};

export function sampleExtFor(mimeType: string): string {
  return EXT_BY_MIME[mimeType] ?? 'bin';
}

export class VoiceCloneRequestDto {
  @IsString()
  @MaxLength(512)
  @Matches(/^users\/[^/]+\/voices\/[A-Za-z0-9_-]+\/sample\.[a-z0-9]+$/, {
    message:
      'pathname must be the value returned by the voices/upload-url step (users/<userId>/voices/<id>/sample.<ext>)',
  })
  pathname!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(80)
  label!: string;

  /**
   * Явное согласие (TODO §3.6.3) — обязательное поле, не отдельная
   * галочка «я прочитал»: запись используется для клонирования голоса,
   * а не просто хранится, и это должно быть подтверждено осознанно на
   * каждый клон, а не один раз в настройках аккаунта.
   */
  @IsBoolean()
  consent!: boolean;
}
