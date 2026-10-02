/**
 * Всё глобальное приложения — в одной функции: её же зовёт тест
 * приложения (app.setup.spec.ts), чтобы проверять ТОТ ЖЕ конверт, фильтр,
 * валидацию и CORS, что на проде, а не их копию.
 */

import { INestApplication, ValidationPipe } from '@nestjs/common';
import {
  json,
  text,
  type NextFunction,
  type Request,
  type Response,
} from 'express';
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

/**
 * Э3: вебхук целей s2s (§5-тер.1) подписан по СЫРОМУ телу — JSON-парсер
 * его бы пересобрал (порядок ключей, пробелы, кириллица) и подпись не
 * сошлась бы. На этом пути тело приходит строкой (любой Content-Type,
 * ≤ 4 КБ), разбирает его сам маршрут (A) ПОСЛЕ проверки подписи.
 */
export const GOAL_WEBHOOK_PATH = '/assist/v1/sites/:id/goal-events';
/**
 * Э3: события и цели со страницы шлются и `navigator.sendBeacon`
 * (text/plain — простой запрос без preflight, переживает закрытие вкладки):
 * text/plain на этих путях — строкой ≤ 4 КБ, JSON — как обычно.
 */
export const WIDGET_BEACON_PATHS = ['/widget/v1/event', '/widget/v1/goal'];
export const SMALL_BODY_LIMIT = '4kb';

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
  const rawText = text({ type: () => true, limit: SMALL_BODY_LIMIT });
  app.use(
    GOAL_WEBHOOK_PATH,
    function goalWebhookRawText(
      req: Request,
      res: Response,
      next: NextFunction,
    ) {
      rawText(req, res, next);
    },
  );
  const beaconText = text({ type: 'text/plain', limit: SMALL_BODY_LIMIT });
  for (const path of WIDGET_BEACON_PATHS) {
    app.use(
      path,
      function widgetBeaconText(
        req: Request,
        res: Response,
        next: NextFunction,
      ) {
        beaconText(req, res, next);
      },
    );
  }
  app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(new ResponseInterceptor());
}
