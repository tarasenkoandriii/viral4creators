import { IsOptional, IsString, Length } from 'class-validator';

/** POST /sessions/:id/shared-video — поставить готовый ролик на модерацию. */
export class CreateSharedVideoRequestDto {
  /** По умолчанию — название товара (как и у заявки на публикацию). */
  @IsOptional()
  @IsString()
  @Length(1, 100)
  title?: string;
}

/** POST /admin/shared-videos/:id/reject */
export class RejectSharedVideoRequestDto {
  @IsString()
  @Length(3, 1000, { message: 'reason must be between 3 and 1000 characters' })
  reason!: string;
}

/**
 * POST /shared-video/:id/fork — «Сделать такой же». Публичный маршрут:
 * тело — только локаль новой сессии (тот же параметр, что и у обычного
 * POST /sessions, ТЗ §35.5), никакой идентификации не требуется.
 */
export class ForkSharedVideoRequestDto {
  @IsOptional()
  @IsString()
  @Length(2, 10)
  locale?: string;
}
