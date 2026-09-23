import { IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';
import { MAX_CARD_TEXT_LENGTH } from '../../../common/greeting-cards';

/**
 * Текст карточек. Оба поля необязательны и оба допускают `null` —
 * «убрать карточку» это осмысленное действие, отсюда `@ValidateIf`, а
 * не один `@IsOptional`.
 */
export class GreetingCardsRequestDto {
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(MAX_CARD_TEXT_LENGTH)
  title?: string | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(MAX_CARD_TEXT_LENGTH)
  closing?: string | null;
}
