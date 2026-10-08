/**
 * Точка входа sites-backend (Vercel: server.js → dist/main.js).
 *
 * Глобальный префикс НЕ ставится: маршруты ядра и продуктов в ТЗ —
 * `/sites/…`, `/assist/…`, `/qa/…`, `/widget/v1/…`, `/health`
 * (ТЗ помощника §4.16, QA-ТЗ §4.8), и отдельный Vercel-проект делить
 * пространство путей ни с кем не обязан.
 */

// Переменные окружения — до всего остального.
import * as dotenv from 'dotenv';
dotenv.config();

import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import {
  configurationWarnings,
  loadConfiguration,
  validateConfiguration,
} from './config/configuration';

async function bootstrap() {
  const config = loadConfiguration();
  validateConfiguration(config);
  for (const w of configurationWarnings(config)) {
    console.error(`sites-backend: конфигурация — ${w}`);
  }

  const app = await NestFactory.create(AppModule);
  configureApp(app, config);
  await app.listen(config.port);

  console.log(`sites-backend: http://localhost:${config.port}/health`);
}

bootstrap().catch((error) => {
  console.error('sites-backend не стартовал:', error);
  process.exit(1);
});
