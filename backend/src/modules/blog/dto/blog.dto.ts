import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

/** POST /admin/blog — TODO §II.3: "тот же экран управляет ручными записями". */
export class CreateManualBlogPostDto {
  @IsString()
  @Length(1, 60)
  category!: string;

  @IsString()
  @Length(1, 200)
  title!: string;

  @IsString()
  @Length(1, 20_000)
  bodyHtml!: string;

  @IsOptional()
  @IsIn(['ru', 'uk', 'en', 'de', 'es'])
  originalLocale?: string;
}

/** PATCH /admin/blog/:id — правка текста черновика/публикации. */
export class UpdateBlogPostDto {
  @IsOptional()
  @IsString()
  @Length(1, 200)
  title?: string;

  @IsOptional()
  @IsString()
  @Length(1, 20_000)
  bodyHtml?: string;

  @IsOptional()
  @IsString()
  @Length(1, 60)
  category?: string;
}

/** POST /admin/blog/:id/reject — TODO §II.3: "одобрить / отклонить". */
export class RejectBlogPostDto {
  @IsString()
  @Length(1, 300)
  reason!: string;
}

/** GET /admin/blog?status=&category=&page=&pageSize= */
export class AdminBlogQueryDto {
  @IsOptional()
  @IsIn(['DRAFT', 'APPROVED', 'PUBLISHED', 'REJECTED'])
  status?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  category?: string;

  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(1)
  page: number = 1;

  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize: number = 20;
}

/** GET /blog?locale=&category=&page=&pageSize= — публичная витрина. */
export class PublicBlogQueryDto {
  @IsOptional()
  @IsIn(['ru', 'uk', 'en', 'de', 'es'])
  locale?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  category?: string;

  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(1)
  page: number = 1;

  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize: number = 20;
}
