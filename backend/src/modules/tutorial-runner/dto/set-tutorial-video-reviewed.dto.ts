import { IsBoolean, IsOptional, IsString } from 'class-validator';

/** Approval identifies the version actually shown to the operator. */
export class SetTutorialVideoReviewedDto {
  @IsBoolean()
  reviewed!: boolean;

  @IsOptional()
  @IsString()
  expectedBlobUrl?: string;

  @IsOptional()
  @IsString()
  expectedVersionId?: string | null;
}
