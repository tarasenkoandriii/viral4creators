import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';

/** "character:c1" / "scene:s3" / "extra:e1" — the analysis ids, nothing else. */
const KEY = /^(character:c|scene:s|extra:e)\d{1,2}$/;

/** POST /sessions/:id/analysis/previews/upload-url */
export class PreviewUploadUrlsRequestDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(24)
  @IsString({ each: true })
  @Matches(KEY, {
    each: true,
    message: 'each key must be "character:c<N>", "scene:s<N>" or "extra:e<N>"',
  })
  keys!: string[];
}

export class PreviewConfirmItemDto {
  @IsString()
  @Matches(KEY, {
    message: 'key must be "character:c<N>", "scene:s<N>" or "extra:e<N>"',
  })
  key!: string;

  @IsString()
  @MaxLength(512)
  @Matches(
    /^sessions\/[^/]+\/previews\/(character-c|scene-s|extra-e)\d{1,2}\.jpg$/,
    {
      message: 'pathname must be the value returned by upload-url',
    },
  )
  pathname!: string;
}

/** POST /sessions/:id/analysis/previews/confirm */
export class PreviewConfirmRequestDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(24)
  @ValidateNested({ each: true })
  @Type(() => PreviewConfirmItemDto)
  items!: PreviewConfirmItemDto[];
}
