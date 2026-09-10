import {
  ArrayMaxSize,
  IsArray,
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

/** Scene photo — PNG/JPEG only (Veo referenceImage input formats). */
export class ScenePhotoUploadUrlRequestDto {
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

export class SceneConfirmRequestDto {
  @IsString()
  @MaxLength(512)
  @Matches(/^sessions\/[^/]+\/scenes\/[A-Za-z0-9_-]+\/photo\.(png|jpg)$/, {
    message:
      'pathname must be the value returned by the upload-url step (sessions/<sessionId>/scenes/<sceneId>/photo.<png|jpg>)',
  })
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

export class SceneUpdateRequestDto {
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

/** PUT /sessions/:id/references — ordered candidate ids, ≤3. */
export class PutReferenceSlotsRequestDto {
  @IsArray()
  @ArrayMaxSize(3)
  @IsString({ each: true })
  @Matches(/^(character:c\d{1,2}|scene:[A-Za-z0-9_-]+|product)$/, {
    each: true,
    message: 'slot ids look like "character:c1", "scene:<id>" or "product"',
  })
  slots!: string[];
}
