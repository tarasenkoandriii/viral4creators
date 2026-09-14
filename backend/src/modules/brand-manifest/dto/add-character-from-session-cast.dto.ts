import { IsOptional, IsString, Length, ValidateIf } from 'class-validator';

/**
 * POST /brand-manifests/:id/characters/from-session-cast — доп. запрос
 * владельца продукта: сохранить замену персонажа, сделанную НА ЭКРАНЕ
 * СЕССИИ (`CharacterCasting.tsx`, `kind: 'photo' | 'text'`), как
 * постоянного персонажа бренда — чтобы не повторять фото/описание
 * вручную в каждой новой сессии того же бренда.
 *
 * `kind: 'brand'` сюда не попадает вовсе — такая замена уже ссылается
 * на существующего персонажа бренда (`brandCharacterId`), добавлять
 * нечего (фронтенд не должен показывать кнопку для этого случая).
 */
export class AddCharacterFromSessionCastDto {
  @IsString()
  @Length(1, 80, { message: 'label must be between 1 and 80 characters' })
  label!: string;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Length(1, 2000, {
    message: 'description must be between 1 and 2000 characters',
  })
  description?: string | null;

  /**
   * Blob pathname сессионного фото (`CastReplacement.photoPathname`) —
   * копируется в постоянный путь бренда через `BlobService.copyBlob()`,
   * не переиспользуется напрямую: сессионное фото удаляется вместе с
   * сессией (см. доккомментарий `CastReplacement.photoPathname`),
   * ссылка на него стала бы битой.
   */
  @IsOptional()
  @IsString()
  @Length(1, 500)
  photoPathname?: string | null;
}
