import { Type } from 'class-transformer';
import {
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

/**
 * Голос Soniox (S2). `voiceId: null` (или пусто) — голос Soniox по
 * умолчанию; поэтому сам выбор — объект, а «снять» — `null` вместо него.
 */
export class GreetingSonioxVoiceChoiceDto {
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(64)
  voiceId?: string | null;
}

/**
 * Выбор голоса отправителя (фича №34).
 *
 * `null` — осмысленное значение (снять выбор), поэтому `@IsOptional()`
 * здесь не подошёл бы в одиночку: он пропускает и `undefined`, и `null`
 * мимо остальных правил, а нам нужно, чтобы СТРОКА всё-таки
 * проверялась. Отсюда `@ValidateIf` — правила применяются только к
 * непустому значению.
 */
export class GreetingSenderVoiceRequestDto {
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(128)
  resembleVoiceId?: string | null;

  /**
   * Пресетный голос xAI — реплику произносит модель в кадре.
   * Присутствие этого поля (пусть и `null`) означает «правлю
   * пресетный голос»; без него правится свой клон. Оба сразу не
   * посылаются: выбор взаимоисключающий, и контроллер читает
   * `presetVoiceId` первым.
   */
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(64)
  presetVoiceId?: string | null;

  /**
   * Голос каталога Soniox (S2): `{ voiceId }` — выбрать (`null` — голос
   * Soniox по умолчанию), `null` — снять. Контроллер читает его первым.
   */
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsObject()
  @ValidateNested()
  @Type(() => GreetingSonioxVoiceChoiceDto)
  sonioxVoice?: GreetingSonioxVoiceChoiceDto | null;
}
