import { Type } from 'class-transformer';
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
} from 'class-validator';
import { STORY_REFERENCE_STATUSES } from './story-references.service';
import type { StoryReferenceStatus } from './story-references.service';

/** GET /story-gifts/references?query=&status= */
export class StoryReferenceListQuery {
  @IsOptional() @IsString() @MaxLength(100) query?: string;
  @IsOptional() @IsIn(STORY_REFERENCE_STATUSES) status?: StoryReferenceStatus;
}
/** PATCH /story-gifts/references/:videoId — null/absent unlinks. */
export class StoryReferenceLinkDto {
  @IsOptional() @IsString() @MaxLength(80) editionId?: string | null;
}
/** GET /story-gifts/references/:videoId/plan */
export class StoryReferencePlanQuery {
  @IsOptional() @IsString() @MaxLength(80) editionId?: string;
  @Type(() => Number)
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(1)
  @Max(1000)
  budgetUsd?: number;
  @IsOptional() @IsString() @MaxLength(180) preambleText?: string;
}
/** GET /story-gifts/references/youtube?q=&language= */
export class StoryReferenceSearchQuery {
  @IsString() @Length(2, 120) q!: string;
  @IsOptional() @Matches(/^[a-z]{2}$/) language?: string;
}
