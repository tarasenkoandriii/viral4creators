import type { NextFunction, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';

/**
 * Отказ CORS по списку (аудит Админки S3-6). Пакет `cors` передаёт ошибку
 * колбэка `origin` в `next(err)` — раньше она доходила до обработчика
 * express по умолчанию и давала 500 со стеком в логе (запрос при этом не
 * выполнялся). Отказ остаётся ДО обработчика маршрута (чужая страница не
 * должна запускать его даже «простым» запросом с cookie), но ответ — 403 в
 * общем конверте ошибки, без текста исключения и без origin в ответе.
 * Та же схема, что у sites-backend (`sites-backend/src/common/cors.ts`).
 */
export class CorsOriginDeniedError extends Error {
  readonly status = 403;
  constructor() {
    super('Origin не разрешён CORS');
    this.name = 'CorsOriginDeniedError';
  }
}

/** Error-middleware express сразу после `cors`: 403 вместо 500. */
export function corsDeniedHandler(
  err: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!(err instanceof CorsOriginDeniedError)) return next(err);
  const url = req.originalUrl ?? req.url ?? '';
  const q = url.indexOf('?');
  res.status(403).json({
    success: false,
    error: {
      code: 'ORIGIN_DENIED',
      message: 'Запрос с этого сайта не разрешён',
    },
    meta: {
      timestamp: new Date().toISOString(),
      requestId: uuidv4(),
      path: q === -1 ? url : url.slice(0, q),
    },
  });
}
