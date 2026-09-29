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
  GreetingRegister,
  GreetingPresenterProvider,
  GreetingResolution,
  GreetingTone,
} from '../../../common/types/greeting.types';
import {
  GREETING_OCCASIONS,
  GREETING_REGISTERS,
  MAX_CUSTOM_OCCASION_LENGTH,
  GREETING_TONES,
} from '../../../common/types/greeting.types';
import { SUPPORTED_LOCALES } from '../../../common/locale';
import type { SupportedLocale } from '../../../common/locale';

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
  @Length(1, MAX_CUSTOM_OCCASION_LENGTH)
  customOccasionText?: string | null;

  /**
   * Этап B (ТЗ docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md
   * §3.4): ответ человека на вопрос «какое это событие по настроению» —
   * только для OTHER. Это ОДИН из трёх сигналов: сервер может поднять
   * регистр ключевыми словами и классификатором, но не опустить.
   *
   * Этап D (§3.4 п.1, приёмка §8.1): для OTHER ответ ОБЯЗАТЕЛЕН — без него
   * (или с явным `null`) сервис отвечает 400 `OTHER_MOOD_REQUIRED`.
   * Здесь поле остаётся необязательным, потому что обязательность зависит
   * от итогового повода, а его знает только сервис (при правке повод
   * может прийти из текущего брифа). У каталожных поводов поле
   * игнорируется.
   *
   * Не передано — берётся сохранённый ответ человека
   * (`userOccasionRegister`; у строк до этой колонки — `occasionRegister`
   * при источнике 'user', `storedUserRegister`); ответа нет — 400.
   */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsIn([...GREETING_REGISTERS])
  occasionRegister?: GreetingRegister | null;

  /**
   * Этап C (ТЗ docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md
   * §3.8): язык поздравления. Не обязан совпадать с языком интерфейса.
   */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsIn([...SUPPORTED_LOCALES])
  scriptLanguage?: SupportedLocale | null;

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
