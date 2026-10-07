import {
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

/**
 * PATCH /admin/tutorial-demo-quality/checks/:id/override — оператор
 * переопределяет вердикт проверки (заход 7). `verdict: null` — снять своё
 * переопределение; причина обязательна в обоих случаях (журнал).
 */
export class DemoQualityOverrideDto {
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsIn(['ok', 'warn', 'fail'])
  verdict?: 'ok' | 'warn' | 'fail' | null;

  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}
