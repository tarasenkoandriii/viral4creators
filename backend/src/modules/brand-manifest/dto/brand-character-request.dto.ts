import { IsOptional, IsString, Length, ValidateIf } from 'class-validator';

/**
 * POST /brand-manifests/:id/characters and PATCH .../characters/:characterId;
 * reused verbatim for .../scenes (§17.1) — a scene has the same fields.
 * The photo is NOT here — it goes through the presigned Blob flow
 * (photo/upload-url → PUT → photo/confirm), same as every file in the app.
 */
export class BrandCharacterRequestDto {
  @IsOptional()
  @IsString()
  @Length(1, 80, { message: 'label must be between 1 and 80 characters' })
  label?: string;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Length(1, 2000, {
    message: 'description must be between 1 and 2000 characters',
  })
  description?: string | null;
}
