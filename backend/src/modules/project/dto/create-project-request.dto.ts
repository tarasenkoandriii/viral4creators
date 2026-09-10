import { IsIn, IsOptional, IsString, Length, Matches } from 'class-validator';
import type { ProjectType } from '../../../common/types/project.types';

/**
 * POST /projects — spec §4 Экран 1.
 *
 * No `currency` field on purpose: it is derived from `countryCode` on the
 * server (spec §7.2, decided — no manual override in v1). Sending one is
 * rejected by the global ValidationPipe's forbidNonWhitelisted.
 */
export class CreateProjectRequestDto {
  @IsIn(['SINGLE', 'LINE'], {
    message: 'type must be SINGLE (один товар) or LINE (линейка)',
  })
  type!: ProjectType;

  @IsString()
  @Length(1, 120, { message: 'title must be between 1 and 120 characters' })
  title!: string;

  /** ISO 3166-1 alpha-2; validated against the reference list in the service. */
  @IsString()
  @Matches(/^[A-Za-z]{2}$/, {
    message: 'countryCode must be a 2-letter ISO 3166-1 code, e.g. "UA"',
  })
  countryCode!: string;

  /** Optional link to a Brand Manifest (spec §12); must belong to the caller. */
  @IsOptional()
  @IsString()
  brandManifestId?: string;
}
