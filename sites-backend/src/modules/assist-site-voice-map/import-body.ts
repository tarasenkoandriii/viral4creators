/**
 * Тело импорта голосовой карты (Э6-тер, хвост аудита (4); Э6-тер (к)):
 * файл карты с 500 целями и мемо больше общих 100 КБ JSON-парсера Nest.
 * Потолок поднимается ТОЛЬКО этому маршруту кабинета — до 1 МБ; больше —
 * 413 `VOICE_MAP_IMPORT_TOO_LARGE` в общем конверте до маршрута (тело дальше
 * не читается, черновик не трогается). Подключение — `app.setup.ts` (раньше
 * общего парсера Nest; обёртка со СВОИМ именем — см. комментарий там).
 */
import { json, type NextFunction, type Request, type Response } from 'express';

export const VOICE_MAP_IMPORT_PATH = '/assist/sites/:id/voice-map/site/import';
export const VOICE_MAP_IMPORT_BODY_LIMIT = '1mb';

export function voiceMapImportJson() {
  const parse = json({ limit: VOICE_MAP_IMPORT_BODY_LIMIT });
  return function voiceMapImportBody(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    parse(req, res, (err?: unknown) => {
      if (!err) return next();
      const tooLarge = (err as { type?: string }).type === 'entity.too.large';
      res.status(tooLarge ? 413 : 400).json({
        success: false,
        error: tooLarge
          ? {
              code: 'VOICE_MAP_IMPORT_TOO_LARGE',
              message: 'Файл карты больше 1 МБ',
            }
          : { code: 'BAD_REQUEST', message: 'Неверный запрос' },
        meta: {
          timestamp: new Date().toISOString(),
          path: VOICE_MAP_IMPORT_PATH,
        },
      });
    });
  };
}
