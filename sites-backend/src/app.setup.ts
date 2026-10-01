/**
 * Всё глобальное приложения — в одной функции: её же зовёт тест
 * приложения (app.setup.spec.ts), чтобы проверять ТОТ ЖЕ конверт, фильтр,
 * валидацию и CORS, что на проде, а не их копию.
 */

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { json, type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { VALIDATION_PIPE_OPTIONS } from './common/validation-pipe';
import { corsDeniedHandler, corsOptionsDelegate } from './common/cors';
import { SitesConfig } from './config/configuration';

/**
 * Э2: картинка бренда приходит JSON-ом `{ kind, mime, dataBase64 }` —
 * 200 КБ байтов в base64 ≈ 273 КБ, больше 100 КБ JSON-парсера Nest по
 * умолчанию. Поднимаем потолок ТОЛЬКО этому маршруту кабинета; остальным
 * остаётся 100 КБ (публичные маршруты виджета и лендинга режут тела ещё
 * раньше своими потолками).
 */
export const ASSET_UPLOAD_PATH = '/assist/sites/:id/widget/assets';
export const ASSET_UPLOAD_JSON_LIMIT = '300kb';

export function configureApp(app: INestApplication, config: SitesConfig) {
  // API отдаёт только JSON: CSP/COEP ему не нужны, а nosniff, HSTS и
  // отсутствие X-Powered-By стоят одну строку (как у backend).
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: false,
    }),
  );
  // Правила по путям (виджет Э2 — свои) — common/cors.ts.
  app.enableCors(corsOptionsDelegate(config));
  // Сразу за `cors`: его отказ — 403 в конверте, а не 500 express.
  app.use(corsDeniedHandler);
  // Раньше общего парсера Nest (он регистрируется в `init`): разобранное
  // тело (`req._body`) общий парсер уже не трогает. Обёртка с СВОИМ именем
  // обязательна: Nest пропускает общий парсер, если в стеке express уже
  // есть слой с именем `jsonParser` (имя функции body-parser), — и тогда
  // JSON перестал бы разбираться на всех остальных маршрутах.
  const assetJson = json({ limit: ASSET_UPLOAD_JSON_LIMIT });
  app.use(
    ASSET_UPLOAD_PATH,
    function assetUploadJson(req: Request, res: Response, next: NextFunction) {
      assetJson(req, res, next);
    },
  );
  app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(new ResponseInterceptor());
}
