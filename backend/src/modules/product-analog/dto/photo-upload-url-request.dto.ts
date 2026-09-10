import { IsIn, IsNumber, IsString, Max, MaxLength, Min } from 'class-validator';

/**
 * POST /projects/:id/items/:itemId/photo/upload-url — same shape as the
 * session product-image DTO (UploadProductImageRequestDto), on purpose:
 * the TMA already has an upload helper for exactly this contract.
 */
export class PhotoUploadUrlRequestDto {
  @IsString()
  @MaxLength(255)
  fileName!: string;

  @IsNumber()
  @Min(1)
  @Max(10485760) // 10MB
  fileSize!: number;

  @IsString()
  @IsIn(['image/png', 'image/jpeg', 'image/webp'])
  mimeType!: string;
}
