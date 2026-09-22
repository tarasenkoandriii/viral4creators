import { IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';

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
}
