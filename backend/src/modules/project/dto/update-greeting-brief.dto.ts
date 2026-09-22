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
import {
  GREETING_OCCASIONS,
  GREETING_TONES,
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
  /**
   * Список берётся из `GREETING_OCCASIONS`, а не переписывается строками:
   * до этапа 2 здесь лежала своя копия семи значений, и расширение enum
   * до 24 поводов молча отвергало бы 17 новых на уровне валидации DTO —
   * фича выглядела бы сломанной, хотя база и сервис её уже понимают.
   */
  @IsIn([...GREETING_OCCASIONS])
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
  @IsIn([...GREETING_TONES])
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
