import { IsBoolean, IsOptional, IsString, Length } from 'class-validator';

/** POST /sessions/:id/shared-video — поставить готовый ролик на модерацию. */
export class CreateSharedVideoRequestDto {
  /**
   * По умолчанию — название товара (как и у заявки на публикацию), а у
   * поздравления — повод. Имя получателя в заголовок автоматически не
   * попадает НИКОГДА: это персональные данные третьего лица, которое
   * страницу не публиковало (см. `snapshotFromSession`). Попасть туда
   * оно может только так: автор вписал его в это поле сам.
   */
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

/**
 * POST /admin/shared-videos/:id/showcase — кураторский отбор в витрину
 * (§5 docs-tz/TZ-Greeting-Video-Landing.md). Булево, а не «добавить»/
 * «убрать» двумя маршрутами: оператор жмёт один чек-бокс, и его новое
 * положение и есть тело запроса.
 */
export class SetShowcaseRequestDto {
  @IsBoolean()
  showcase!: boolean;
}
