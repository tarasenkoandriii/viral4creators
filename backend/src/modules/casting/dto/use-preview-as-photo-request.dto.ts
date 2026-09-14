import { IsOptional, IsString, Length, ValidateIf } from 'class-validator';

/**
 * POST /sessions/:sessionId/characters/:characterId/preview/use-as-photo
 * — доп. запрос владельца продукта: продвинуть уже сгенерированное
 * превью (см. `CharacterPreviewRequestDto`) до статуса настоящего фото
 * персонажа.
 */
export class UsePreviewAsPhotoRequestDto {
  /** Pathname из ответа `POST .../preview` (поле `pathname`, не `url`). */
  @IsString()
  @Length(1, 500)
  previewPathname!: string;

  /** Optional words alongside the photo — то же поле, что и у обычного
   * подтверждения фото (`CastPhotoConfirmRequestDto`). */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Length(1, 2000)
  description?: string | null;
}
