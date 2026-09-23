/**
 * Main Application Bootstrap
 *
 * Initializes NestJS application with global filters, interceptors, and CORS.
 */

// Load environment variables FIRST before anything else
import * as dotenv from 'dotenv';
dotenv.config();

import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { VALIDATION_PIPE_OPTIONS } from './common/validation-pipe';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { matchesAllowedOrigin } from './common/cors-origin-match';
import {
  loadConfiguration,
  validateConfiguration,
} from './config/configuration';

async function bootstrap() {
  // Load and validate configuration
  const config = loadConfiguration();
  validateConfiguration(config);

  console.log('Starting UGC Video Generator API...');
  console.log(`Environment: ${config.nodeEnv}`);
  console.log(`Port: ${config.port}`);

  // Create NestJS application
  const app = await NestFactory.create(AppModule);

  // Set global prefix
  app.setGlobalPrefix('api');

  // Этап 54 (Б-3.7): заголовки безопасности. API отдаёт только JSON, так
  // что CSP и COEP ему не нужны — а вот `X-Content-Type-Options`, HSTS и
  // отсутствие `X-Powered-By` стоят одну строку. CSP выключен явно: с ним
  // ответ на прямое открытие `/api/health` в браузере выглядел бы
  // сломанным, а защищать в JSON-ответе нечего.
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: false,
    }),
  );

  // Enable CORS
  //
  // CORS_ORIGIN is a comma-separated list (see configuration.ts) so both
  // the Production frontend and every Preview deployment can be allowed
  // at once, without redeploying the backend for each new Vercel preview
  // URL — list the stable production frontend origin plus a "*.vercel.app"
  // wildcard entry to cover previews. See doc/VERCEL-READINESS-AUDIT.md,
  // finding #7, and doc/DEPLOYMENT.md for the full two-project Vercel setup.
  const allowedOrigins = config.cors.origins;
  app.enableCors({
    origin: (
      requestOrigin: string | undefined,
      callback: (err: Error | null, allow?: boolean) => void,
    ) => {
      // No Origin header at all (server-to-server calls, curl, health
      // checks) — nothing to check against, let it through.
      if (!requestOrigin) {
        return callback(null, true);
      }

      // Вынесено в common/cors-origin-match.ts (ТЗ ассистента на
      // лендинге, §4.2.3): та же логика теперь нужна и
      // `PublicOriginGuard` — сравнение осталось буквально тем же.
      const isAllowed = matchesAllowedOrigin(requestOrigin, allowedOrigins);

      callback(
        isAllowed
          ? null
          : new Error(`Origin ${requestOrigin} not allowed by CORS`),
        isAllowed,
      );
    },
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    credentials: true,
  });
  // М-4.4 седьмого аудита (снятие `Access-Control-Allow-Credentials` для
  // wildcard-origin'ов) ОТКАЧЕНО в тот же день: мини-апп шлёт ВСЕ запросы
  // с `withCredentials: true` (frontend/src/services/api.ts), и браузер
  // при этом отвергает любой ответ без заголовка — прод-фронт на
  // `*.vercel.app` получал «нет связи с сервером» при 200 на сервере.
  // Правильный путь — либо перечислить прод-origin в CORS_ORIGIN точной
  // строкой И сделать `withCredentials` условным на фронте (только когда
  // есть cookie-логин), либо оставить как есть; см. отчёт аудита.

  // Global validation pipe. Настройки — в `common/validation-pipe.ts`:
  // их же берут контрактные тесты маршрутов, иначе они проверяли бы
  // свою копию валидации, а не эту.
  app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));

  // Global exception filter
  app.useGlobalFilters(new HttpExceptionFilter());

  // Global response interceptor
  app.useGlobalInterceptors(new ResponseInterceptor());

  // Start server
  await app.listen(config.port);

  console.log(`Application is running on: http://localhost:${config.port}`);
  console.log(`API endpoint: http://localhost:${config.port}/api`);
  console.log(`Health check: http://localhost:${config.port}/api/health`);
}

bootstrap().catch((error) => {
  console.error('Failed to start application:', error);
  process.exit(1);
});
