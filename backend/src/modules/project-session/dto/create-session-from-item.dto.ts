import { IsIn, IsOptional } from 'class-validator';
import { SUPPORTED_LOCALES } from '../../../common/locale';

/**
 * POST /projects/:projectId/items/:itemId/sessions — необязательное тело.
 * `locale` — UI-локаль фронтенда на момент старта сессии (этап 59, ТЗ
 * §35.5); отсутствует у клиентов, которые ещё не обновились, и это не
 * ошибка (см. `normalizeLocale()` в common/locale.ts).
 */
export class CreateSessionFromItemRequestDto {
  @IsOptional()
  @IsIn(SUPPORTED_LOCALES)
  locale?: string;
}
