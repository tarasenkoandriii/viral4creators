import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { STICKER_PLACEMENTS } from '../../../common/sticker-overlay';

export class GreetingStickerSelectRequestDto {
  /**
   * Тот же запрос, по которому получена выдача. Нужен не для красоты:
   * кандидат берётся из кеша ЭТОГО запроса, а не из тела, — иначе
   * клиент мог бы заставить сервер скачать что угодно откуда угодно.
   */
  @IsString()
  @MaxLength(100)
  query!: string;

  @IsString()
  @MaxLength(32)
  stickerId!: string;

  @IsOptional()
  @IsString()
  @IsIn(STICKER_PLACEMENTS as unknown as string[])
  placement?: string;
}

export class GreetingStickerPlacementRequestDto {
  @IsString()
  @IsIn(STICKER_PLACEMENTS as unknown as string[])
  placement!: string;
}
