import { Type } from 'class-transformer';
import { IsOwnBlobUrl } from '../../../common/is-own-blob-url.validator';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  Validate,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

/**
 * PUT /sessions/:sessionId/characters — the whole casting list at once
 * (the screen is a single form; sending the full set keeps "unchecked"
 * unambiguous). Photo URLs are only accepted for kind=brand (they come
 * from the manifest snapshot); a session-uploaded photo is attached by
 * the photo endpoints below, never by URL from the client.
 */
export class CastReplacementDto {
  @IsIn(['none', 'photo', 'text', 'brand'])
  kind!: 'none' | 'photo' | 'text' | 'brand';

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Length(1, 2000, {
    message: 'description must be between 1 and 2000 characters',
  })
  description?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  // §12/А-2.11: адрес должен вести в НАШЕ хранилище. Проверки «это
  // https-URL» мало: сервер потом скачивает эту картинку, и любой
  // внешний адрес превращает его в чужого агента.
  @IsUrl({ require_protocol: true, protocols: ['https'] })
  @Validate(IsOwnBlobUrl)
  photoUrl?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(64)
  brandCharacterId?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(80)
  label?: string | null;
}

export class CharacterCastDto {
  @IsString()
  @Matches(/^c\d{1,2}$/, { message: 'characterId must look like "c1"' })
  characterId!: string;

  @IsBoolean()
  active!: boolean;

  @IsInt()
  @Min(0)
  order!: number;

  @ValidateNested()
  @Type(() => CastReplacementDto)
  replacement!: CastReplacementDto;
}

export class PutCastingRequestDto {
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => CharacterCastDto)
  casts!: CharacterCastDto[];
}

/** Same PNG/JPEG-only rule as brand-character photos — Veo input formats. */
export class CastPhotoUploadUrlRequestDto {
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

export class CastPhotoConfirmRequestDto {
  @IsString()
  @MaxLength(512)
  @Matches(/^sessions\/[^/]+\/characters\/c\d{1,2}\/photo\.(png|jpg)$/, {
    message:
      'pathname must be the value returned by the photo/upload-url step (sessions/<sessionId>/characters/<characterId>/photo.<png|jpg>)',
  })
  pathname!: string;

  /** Optional words alongside the photo — kept for the prompt when the photo doesn't fit the 3-image cap (§10.3). */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Length(1, 2000)
  description?: string | null;
}
