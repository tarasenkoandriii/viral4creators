import { IsIn, IsOptional, IsString, IsUrl, Length } from 'class-validator';

/**
 * POST /portfolio-items — self-upload (ТЗ §7, §10 «Важно»: на Этапе 0 нет
 * стороннего заказчика на платформе, поэтому нужно только собственное
 * согласие Creator — оно проставляется сервисом, не полем формы).
 */
export class CreatePortfolioItemDto {
  @IsUrl(
    {},
    { message: 'videoUrl must be a public link to the finished video' },
  )
  videoUrl!: string;

  @Length(1, 150)
  title!: string;

  @IsOptional()
  @IsUrl()
  thumbnailUrl?: string;

  /** §20 №20 — тематическая подборка, необязательна при загрузке. */
  @IsOptional()
  @IsString()
  @Length(1, 60)
  collectionTag?: string;

  /** Водяной знак на публичном превью (§9/§22, защита от пиратства) — не задан = SITE_NAME по умолчанию. */
  @IsOptional()
  @IsIn(['SITE_NAME', 'CUSTOM', 'NONE'])
  watermarkMode?: 'SITE_NAME' | 'CUSTOM' | 'NONE';

  /** Обязателен, если watermarkMode: 'CUSTOM' — проверяется в сервисе, не декоратором. */
  @IsOptional()
  @IsString()
  @Length(1, 60)
  watermarkText?: string;

  @IsOptional()
  @IsIn(['SLIGHT', 'STANDARD', 'STRONG'])
  watermarkIntensity?: 'SLIGHT' | 'STANDARD' | 'STRONG';
}

/**
 * PATCH /portfolio-items/:id — меняет подборку (§20 №20) и настройки
 * водяного знака (§9/§22). `null` у collectionTag очищает тег,
 * `undefined` не трогает поле — то же самое для watermarkText.
 */
export class UpdatePortfolioItemDto {
  @IsOptional()
  @IsString()
  @Length(1, 60)
  collectionTag?: string | null;

  @IsOptional()
  @IsIn(['SITE_NAME', 'CUSTOM', 'NONE'])
  watermarkMode?: 'SITE_NAME' | 'CUSTOM' | 'NONE';

  @IsOptional()
  @IsString()
  @Length(1, 60)
  watermarkText?: string | null;

  @IsOptional()
  @IsIn(['SLIGHT', 'STANDARD', 'STRONG'])
  watermarkIntensity?: 'SLIGHT' | 'STANDARD' | 'STRONG';
}

/** POST /admin/portfolio-items/:id/reject */
export class RejectPortfolioItemDto {
  @Length(3, 1000, { message: 'reason must be between 3 and 1000 characters' })
  reason!: string;
}
