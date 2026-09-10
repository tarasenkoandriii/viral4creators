import {
  IsIn,
  IsOptional,
  IsString,
  Length,
  Matches,
  ValidateIf,
} from 'class-validator';
import type { ProjectType } from '../../../common/types/project.types';

/**
 * PATCH /projects/:id — every field optional; only the ones present are
 * changed. `brandManifestId: null` explicitly DETACHES the manifest
 * (ValidateIf lets null through the @IsString check).
 */
export class UpdateProjectRequestDto {
  @IsOptional()
  @IsIn(['SINGLE', 'LINE'])
  type?: ProjectType;

  @IsOptional()
  @IsString()
  @Length(1, 120, { message: 'title must be between 1 and 120 characters' })
  title?: string;

  /**
   * Changing the country changes the currency of every price in the
   * project — the service only allows it while no item has a price yet
   * (otherwise the stored numbers would silently mean a different
   * currency). See ProjectService.updateProject.
   */
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z]{2}$/, {
    message: 'countryCode must be a 2-letter ISO 3166-1 code, e.g. "UA"',
  })
  countryCode?: string;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  brandManifestId?: string | null;
}
