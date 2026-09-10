import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import type { ProductPriceSource } from '../../../common/types/project.types';

/**
 * Target audience of the product (spec §18) as the user edits it. Every
 * field optional/nullable; the service stamps `source: 'user'` so a later
 * photo re-recognition does not overwrite a hand-written profile.
 */
export class AudienceInputDto {
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(80)
  ageRange?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsIn(['women', 'men', 'any'])
  gender?: 'women' | 'men' | 'any' | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  interests?: string[];

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(600)
  summary?: string | null;
}

/**
 * Shared body for POST /projects/:id/items and PATCH /projects/:id/items/:itemId
 * — everything optional so an item can be created as an empty draft
 * (spec §7.4: nothing is required to SAVE, only to count as complete).
 *
 * Fields deliberately absent — set by other flows, never by this form:
 *  - photoUrl / photoHash: the photo → analog-search flow (Stage 4);
 *  - category: auto-detected from the photo (spec §9.4, decided — no
 *    manual entry). The global forbidNonWhitelisted rejects them here.
 */
export class ProductItemRequestDto {
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @Length(1, 120, { message: 'title must be between 1 and 120 characters' })
  title?: string | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @Length(1, 2000, {
    message: 'description must be between 1 and 2000 characters',
  })
  description?: string | null;

  /**
   * In the project's currency. `null` clears the price. Max 2 decimals —
   * matches the DECIMAL(12,2) column; more would be silently rounded by
   * Postgres, so reject it here instead.
   */
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsNumber(
    { maxDecimalPlaces: 2 },
    { message: 'price must be a number with at most 2 decimal places' },
  )
  @Min(0, { message: 'price must be >= 0' })
  price?: number | null;

  /** MANUAL (typed in) or ANALOG (taken from a found analog's price) — spec §4 Экран 5. */
  @IsOptional()
  @IsIn(['MANUAL', 'ANALOG'])
  priceSource?: ProductPriceSource;

  /** Spec §18: the user's correction of the audience; `null` clears it. */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @ValidateNested()
  @Type(() => AudienceInputDto)
  audience?: AudienceInputDto | null;
}
