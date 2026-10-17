import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

/** POST /admin/tutorial-demo-quality/assets/:id/check — какой файл
 *  проверить: версию темпа или (без `versionId`) текущий файл ролика. */
export class DemoQualityCheckRequestDto {
  @IsOptional()
  @IsBoolean()
  ownClientSiteAccepted?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  versionId?: string;
}
