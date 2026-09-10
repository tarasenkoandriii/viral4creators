import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { Type } from 'class-transformer';

/** GET /library/recommend?sessionId=…&limit=… */
export class RecommendQueryDto {
  @IsString()
  @Length(1, 64)
  sessionId!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(24)
  limit: number = 12;
}

/** POST /sessions/:id/video/library */
export class UseLibraryEntryRequestDto {
  @IsString()
  @Length(1, 64)
  entryId!: string;
}

/** PATCH /admin/library/:id — решение оператора (§21.1). */
export class UpdateLibraryEntryRequestDto {
  @IsOptional()
  @IsIn(['PUBLIC', 'PRIVATE', 'HIDDEN'])
  visibility?: 'PUBLIC' | 'PRIVATE' | 'HIDDEN';

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(300)
  hiddenReason?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(60)
  category?: string | null;
}
