import {
  IsIn,
  IsNumber,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * Brand-character (and, since Stage 22, brand-scene) photo — presigned
 * Blob flow. Both assets share these DTOs; the service checks the exact
 * `characters/` vs `scenes/` prefix against the route.
 *
 * Only PNG/JPEG: this image is destined for Veo 3.1 as a `referenceImage`
 * (spec §10.2), and Veo's image inputs are JPEG/PNG — accepting WebP here
 * would only fail later, at generation time, where it's far harder to
 * explain to the user.
 */
export class CharacterPhotoUploadUrlRequestDto {
  @IsString()
  @MaxLength(255)
  fileName!: string;

  @IsNumber()
  @Min(1)
  @Max(10485760) // 10MB
  fileSize!: number;

  @IsString()
  @IsIn(['image/png', 'image/jpeg'])
  mimeType!: string;
}

export class CharacterPhotoConfirmRequestDto {
  @IsString()
  @MaxLength(512)
  @Matches(
    /^brand-manifests\/[^/]+\/(characters|scenes)\/[^/]+\/photo\.(png|jpg)$/,
    {
      message:
        'pathname must be the value returned by the photo/upload-url step (brand-manifests/<manifestId>/<characters|scenes>/<id>/photo.<png|jpg>)',
    },
  )
  pathname!: string;
}
