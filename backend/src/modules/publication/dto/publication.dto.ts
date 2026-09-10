import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  Length,
  MaxLength,
} from 'class-validator';

/** POST /sessions/:id/publications — put the finished video in the queue. */
export class CreatePublicationRequestDto {
  @IsIn(['YOUTUBE', 'TIKTOK'])
  platform!: 'YOUTUBE' | 'TIKTOK';

  /** Defaults to the product name. YouTube caps titles at 100 chars. */
  @IsOptional()
  @IsString()
  @Length(1, 100)
  title?: string;

  /** Defaults to the product description. */
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  /** Extra tags; the product category (spec §8) is always added server-side. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  tags?: string[];
}

/** POST /admin/publications/:id/reject */
export class RejectPublicationRequestDto {
  @IsString()
  @Length(3, 1000, { message: 'reason must be between 3 and 1000 characters' })
  reason!: string;
}

/**
 * POST /admin/publications/:id/approve (этап 61, ТЗ §14.2/14.3) — оба
 * поля необязательны: без `channelId` сервис сам разрешает канал
 * (Project → BrandManifest → единственный канал автора на платформе),
 * без `privacy` заявка остаётся с тем значением, что было у неё со
 * снимка (по умолчанию PRIVATE).
 */
export class ApprovePublicationRequestDto {
  @IsOptional()
  @IsString()
  channelId?: string;

  @IsOptional()
  @IsIn(['PRIVATE', 'UNLISTED', 'PUBLIC'])
  privacy?: 'PRIVATE' | 'UNLISTED' | 'PUBLIC';
}
