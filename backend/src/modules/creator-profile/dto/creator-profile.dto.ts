import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  Matches,
  Min,
  ValidateNested,
} from 'class-validator';

const SOCIAL_PLATFORMS = ['instagram', 'tiktok', 'youtube', 'other'] as const;

/** §20 №1 — только латиница/цифры/дефис, как у большинства vanity-URL. */
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,48}[a-z0-9])?$/;

export class SocialLinkDto {
  @IsIn(SOCIAL_PLATFORMS)
  platform!: (typeof SOCIAL_PLATFORMS)[number];

  @IsUrl({}, { message: 'url must be a valid public link' })
  url!: string;
}

/**
 * POST /creator-profiles/quiz — ТЗ §21.8. Явное согласие (`consent`) и
 * хотя бы одна публичная ссылка на соцсеть обязательны: это тот самый
 * «квиз исполнителя», а не тихое включение роли одним кликом.
 */
export class CreatorQuizDto {
  @IsArray()
  @ArrayNotEmpty({ message: 'pick at least one niche' })
  @ArrayMaxSize(10)
  @IsString({ each: true })
  niches!: string[];

  @IsOptional()
  @IsNumber()
  @Min(0)
  priceRangeMin?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  priceRangeMax?: number;

  @IsOptional()
  @IsString()
  @Length(0, 2000)
  bio?: string;

  @IsOptional()
  @IsString()
  @Length(1, 200)
  contactHandle?: string;

  /** §20 №1 — необязательная vanity-ссылка (/creator/moya-marka). */
  @IsOptional()
  @Matches(SLUG_PATTERN, {
    message: 'slug must be lowercase letters, digits and hyphens only',
  })
  slug?: string;

  @IsArray()
  @ArrayMinSize(1, { message: 'at least one public social link is required' })
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => SocialLinkDto)
  socialLinks!: SocialLinkDto[];

  /** Явный чекбокс согласия на публичный профиль — не default(true) нигде. */
  @IsBoolean()
  consent!: boolean;
}

/**
 * PATCH /creator-profiles/me — редактирование и обратимый toggle приёма
 * заказов. Поля явно допускают `null`, а не только `undefined`: класс-
 * валидатор `@IsOptional()` и так пропускает `null` без проверки, но тип
 * `string?` этого не отражал — приходилось либо не трогать поле, либо
 * задавать новое значение, а «очистить обратно» было нечем выразить.
 * Аудит-фикс: `undefined` = не менять это поле, `null` = очистить его.
 */
export class UpdateCreatorProfileDto {
  @IsOptional()
  @IsBoolean()
  isAcceptingOrders?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  niches?: string[];

  @IsOptional()
  @IsNumber()
  @Min(0)
  priceRangeMin?: number | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  priceRangeMax?: number | null;

  @IsOptional()
  @IsString()
  @Length(0, 2000)
  bio?: string | null;

  @IsOptional()
  @IsString()
  @Length(1, 200)
  contactHandle?: string | null;

  /** §20 №1 — можно завести/сменить vanity-ссылку позже, или очистить (`null`). */
  @IsOptional()
  @Matches(SLUG_PATTERN, {
    message: 'slug must be lowercase letters, digits and hyphens only',
  })
  slug?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => SocialLinkDto)
  socialLinks?: SocialLinkDto[];
}
