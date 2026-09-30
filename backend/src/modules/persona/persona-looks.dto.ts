/**
 * DTO образов персоны (ТЗ TZ-Greeting-2.0 §6: `POST /personas/me/looks`,
 * `PATCH /personas/me/looks/:id`).
 *
 * Полей с путём к файлу или URL здесь НЕТ и быть не должно (Т-5): образ
 * рисуется из селфи персоны или другого её образа, источник сервер
 * находит сам. Глобальный ValidationPipe с `forbidNonWhitelisted`
 * отвечает 400 на лишнее поле — присланный `photoUrl` не проскочит.
 */

import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';
import {
  LOOK_AGE_MAX,
  LOOK_AGE_MIN,
  PERSONA_LOOK_PRESETS,
  PersonaLookPreset,
} from './persona-looks.rules';

export class CreatePersonaLookDto {
  @IsOptional()
  @IsIn(PERSONA_LOOK_PRESETS as readonly string[])
  preset?: PersonaLookPreset;

  /** Одежда, причёска, макияж, фон — словами. Проходит `findCelebrityLikeness`. */
  @IsOptional()
  @IsString()
  @Length(2, 500)
  description?: string;

  /** Т-6: 18…90 всегда — и здесь, и ещё раз в сервисе. */
  @IsOptional()
  @IsInt()
  @Min(LOOK_AGE_MIN)
  @Max(LOOK_AGE_MAX)
  targetAge?: number;

  /** Другой образ ЭТОЙ ЖЕ персоны; пусто — из селфи (или базового образа). */
  @IsOptional()
  @IsString()
  @Length(1, 64)
  sourceLookId?: string;
}

export class RenamePersonaLookDto {
  @IsString()
  @Length(1, 80)
  label!: string;
}
