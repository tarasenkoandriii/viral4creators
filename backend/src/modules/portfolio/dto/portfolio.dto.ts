import { IsOptional, IsString, IsUrl, Length } from 'class-validator';

/**
 * POST /portfolio-items — self-upload (ТЗ §7, §10 «Важно»: на Этапе 0 нет
 * стороннего заказчика на платформе, поэтому нужно только собственное
 * согласие Creator — оно проставляется сервисом, не полем формы).
 */
export class CreatePortfolioItemDto {
  @IsUrl({}, { message: 'videoUrl must be a public link to the finished video' })
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
}

/** PATCH /portfolio-items/:id — сейчас меняет только подборку (§20 №20). `null` очищает тег, `undefined` не трогает поле. */
export class UpdatePortfolioItemDto {
  @IsOptional()
  @IsString()
  @Length(1, 60)
  collectionTag?: string | null;
}

/** POST /admin/portfolio-items/:id/reject */
export class RejectPortfolioItemDto {
  @Length(3, 1000, { message: 'reason must be between 3 and 1000 characters' })
  reason!: string;
}
