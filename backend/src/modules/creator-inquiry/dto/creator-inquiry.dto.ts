import { IsBoolean, IsIn, IsNumber, IsOptional, IsString, Length, Min } from 'class-validator';

/** Держим список закрытым (ТЗ §21.2/§21.4) — от значения зависит совет по формату. */
export const TARGET_PLATFORMS = [
  'instagram_reels',
  'tiktok',
  'youtube_shorts',
  'youtube_long',
  'other',
] as const;
export type TargetPlatform = (typeof TARGET_PLATFORMS)[number];

/** POST /creator-inquiries — форма брифа (ТЗ §21.2), не Tender: без бюджета-обязательства. */
export class CreateCreatorInquiryDto {
  @IsString()
  @Length(10, 4000)
  productDescription!: string;

  @IsOptional()
  @IsBoolean()
  isProductLine?: boolean;

  @IsOptional()
  @IsString()
  @Length(0, 500)
  goal?: string;

  @IsIn(TARGET_PLATFORMS)
  targetPlatform!: TargetPlatform;

  @IsOptional()
  @IsNumber()
  @Min(0)
  budgetHint?: number;

  @IsOptional()
  @IsString()
  projectId?: string;

  /** ТЗ §21.7 — существующий брендбук, если заказчик прошёл мастер брендбука. */
  @IsOptional()
  @IsString()
  brandManifestId?: string;
}

/** POST /creator-inquiries/:id/contact — заказчик нажал «Связаться» (§21.3). */
export class ContactCreatorDto {
  @IsString()
  creatorProfileId!: string;
}
