/**
 * Main Application Bootstrap
 *
 * Initializes NestJS application with global filters, interceptors, and CORS.
 */

// Load environment variables FIRST before anything else
import * as dotenv from 'dotenv';
dotenv.config();

import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
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

  // Префикс, слои express (`{}` без тела, helmet), CORS, pipe/фильтр/
  // интерцептор — `app.setup.ts` (её же проверяет `app.setup.spec.ts`).
  configureApp(app, config);

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
