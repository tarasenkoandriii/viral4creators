import {
  IsString,
  IsNumber,
  IsEnum,
  IsInt,
  IsOptional,
  Min,
  Max,
  IsNotEmpty,
  MaxLength,
} from 'class-validator';

/**
 * Request DTO for generating presigned video upload URL
 */
export class UploadVideoRequestDto {
  /** Только для показа пользователю: в ключ хранилища не попадает
   * (этап 54, Б-3.5), поэтому достаточно ограничить длину. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  fileName!: string;

  @IsNumber()
  @Min(1)
  @Max(104857600) // 100MB in bytes
  fileSize!: number;

  @IsEnum(['video/mp4', 'video/quicktime', 'video/x-msvideo'])
  mimeType!: string;

  /** Pixel size read by the browser (`video.videoWidth/Height`) — spec §16. */
  @IsOptional()
  @IsInt()
  @Min(16)
  @Max(16384)
  width?: number;

  @IsOptional()
  @IsInt()
  @Min(16)
  @Max(16384)
  height?: number;
}
