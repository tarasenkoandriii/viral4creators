import {
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  Length,
  ValidateIf,
} from 'class-validator';
import type {
  GreetingOccasion,
  GreetingPresenterProvider,
  GreetingResolution,
  GreetingTone,
} from '../../../common/types/greeting.types';

/**
 * PATCH /projects/:id/greeting-brief (ТЗ TZ-Greeting-Video-Project-Type.md
 * §8) — редактирование брифа после создания проекта, но до запуска
 * генерации: изменить текст, повод, тон и т. д. Всё необязательно
 * (partial update), в отличие от `CreateGreetingBriefDto`, где
 * `occasion`/`recipientName` обязательны при создании.
 *
 * `presenterProvider`/`resolution` перепроверяются против тарифа тем же
 * `resolveGreetingConfig`, что и при создании (§7) — правка снимка,
 * значит и правка выбора провайдера/качества — тоже активное действие,
 * которое обязано пройти гейт, а не только создание.
 */
export class UpdateGreetingBriefDto {
  @IsOptional()
  @IsIn(['BIRTHDAY', 'WEDDING', 'ANNIVERSARY', 'NEW_YEAR', 'GRADUATION', 'CORPORATE', 'OTHER'])
  occasion?: GreetingOccasion;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Length(1, 200)
  customOccasionText?: string | null;

  @IsOptional()
  @IsString()
  @Length(1, 120, {
    message: 'recipientName must be between 1 and 120 characters',
  })
  recipientName?: string;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Length(1, 120)
  senderName?: string | null;

  @IsOptional()
  @IsIn(['WARM', 'FUNNY', 'FORMAL'])
  tone?: GreetingTone;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Length(1, 2000)
  personalMessage?: string | null;

  @IsOptional()
  @IsIn(['grok', 'hedra'])
  presenterProvider?: GreetingPresenterProvider;

  @IsOptional()
  @IsIn(['480p', '720p', '1080p'])
  resolution?: GreetingResolution;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  brandManifestId?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsDateString()
  occasionDate?: string | null;
}
