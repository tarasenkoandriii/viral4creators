import {
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { MODEL_RATES } from '../../../common/ai-pricing';

/** Модели, для которых в прайсе стоит ставка Gemini — те же, что видит вкладка «Расходы». */
export const GEMINI_MODEL_CHOICES = Object.entries(MODEL_RATES)
  .filter(([, rate]) => rate.provider === 'GEMINI')
  .map(([model]) => model);

/** PATCH /admin/settings/assistant (ТЗ §9). Все поля необязательны — частичное обновление. */
export class SetAssistantSettingsDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsBoolean()
  proactiveEnabled?: boolean;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1000)
  dailyBudgetUsd?: number;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  @IsIn(GEMINI_MODEL_CHOICES.length ? GEMINI_MODEL_CHOICES : [''])
  model?: string;
}
