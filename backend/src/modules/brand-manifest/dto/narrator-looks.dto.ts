/**
 * DTO образов рассказчика Story‑Tales (WP5). Полей с путём, URL или
 * свободным текстом здесь нет и быть не должно: исходник — только фото
 * персонажа-рассказчика, промпт — только из кодов пресетов.
 */
import {
  Equals,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  Max,
  Min,
} from 'class-validator';
import {
  NARRATOR_MAKEUPS,
  NARRATOR_OUTFITS,
  NarratorMakeup,
  NarratorOutfit,
  STORY_PARENT_IMAGE_CONSENT_VERSION,
} from '../narrator-looks.rules';

class PaidActionDto {
  /**
   * Резерв, который человек видел на кнопке (микродоллары). Сервер
   * считает свой; больше показанного — 409, цена не растёт молча.
   */
  @IsInt()
  @Min(0)
  @Max(10_000_000)
  maxReserveMicroUsd!: number;

  /**
   * Явный повтор: такой же вариант уже есть (вернётся без оплаты) или
   * прошлая попытка закончилась FAILED/UNKNOWN. Повтор оплачивается заново.
   */
  @IsOptional()
  @IsBoolean()
  repeat?: boolean;
}

export class CreateNarratorLookDto extends PaidActionDto {
  @IsIn(NARRATOR_OUTFITS as readonly string[])
  outfit!: NarratorOutfit;

  @IsIn(NARRATOR_MAKEUPS as readonly string[])
  makeup!: NarratorMakeup;
}

export class RestyleNarratorLookDto extends PaidActionDto {}

export class NarratorImageConsentDto {
  @IsIn([STORY_PARENT_IMAGE_CONSENT_VERSION])
  version!: string;

  @Equals(true)
  accepted!: true;
}
