import {
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

/**
 * Загрузка референс-изображения для Grok reference-to-video
 * (GREETING_VIDEO — доп. запрос: «до 7 изображений, скетч как у
 * остальных изображений проекта»). Те же ограничения формата/размера,
 * что у `ScenePhotoUploadUrlRequestDto` (`reference-assets/dto`) —
 * Grok принимает то же PNG/JPEG по публичному URL, не байтами.
 */
export class GreetingReferenceUploadUrlRequestDto {
  @IsString()
  @MaxLength(255)
  fileName!: string;

  @IsNumber()
  @Min(1)
  @Max(10485760)
  fileSize!: number;

  @IsString()
  @IsIn(['image/png', 'image/jpeg'])
  mimeType!: string;
}

export class GreetingReferenceConfirmRequestDto {
  @IsString()
  @MaxLength(512)
  @Matches(
    /^sessions\/[^/]+\/greeting-refs\/[A-Za-z0-9_-]+\/photo\.(png|jpg)$/,
    {
      message:
        'pathname must be the value returned by the upload-url step (sessions/<sessionId>/greeting-refs/<id>/photo.<png|jpg>)',
    },
  )
  pathname!: string;

  @IsString()
  @Length(1, 80, { message: 'label must be between 1 and 80 characters' })
  label!: string;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Length(1, 2000)
  description?: string | null;
}

export class GreetingReferenceUpdateRequestDto {
  @IsOptional()
  @IsString()
  @Length(1, 80)
  label?: string;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Length(1, 2000)
  description?: string | null;
}

/**
 * Рисование кадра (фича №6) с необязательным выбранным сеттингом
 * (фича №36). Пустое тело — кадр по сцене из каталога поводов, то есть
 * поведение до №36.
 */
export class GreetingFrameRequestDto {
  @IsOptional()
  @IsString()
  @MaxLength(160)
  setting?: string;
}
