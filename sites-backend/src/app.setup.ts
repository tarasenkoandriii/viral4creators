/**
 * Всё глобальное приложения — в одной функции: её же зовёт тест
 * приложения (app.setup.spec.ts), чтобы проверять ТОТ ЖЕ конверт, фильтр,
 * валидацию и CORS, что на проде, а не их копию.
 */

import { INestApplication, ValidationPipe } from '@nestjs/common';
import helmet from 'helmet';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { VALIDATION_PIPE_OPTIONS } from './common/validation-pipe';
import { corsOriginCheck } from './common/cors';
import { SitesConfig } from './config/configuration';

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
  app.enableCors({
    origin: corsOriginCheck(config.corsOrigins),
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    // Авторизация TMA — заголовок с initData, cookie не нужны; но клиент,
    // собранный по образцу frontend/src/services/api.ts, шлёт запросы с
    // `withCredentials: true`, и без этого заголовка браузер отвергнет
    // ответ (урок М-4.4 backend). Origin всё равно сверяется по списку.
    credentials: true,
  });
  app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(new ResponseInterceptor());
}
