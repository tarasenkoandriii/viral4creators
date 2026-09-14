import { IsString, Length } from 'class-validator';

/**
 * POST /sessions/:sessionId/characters/:characterId/preview — доп.
 * запрос владельца продукта: статичное превью персонажа из текстового
 * описания (двойной клик по описанию в `CharacterCasting.tsx`).
 */
export class CharacterPreviewRequestDto {
  @IsString()
  @Length(1, 2000, {
    message: 'description must be between 1 and 2000 characters',
  })
  description!: string;
}
