/**
 * Конфигурация sites-backend из переменных окружения.
 *
 * Сюда — только то, что нужно каркасу (порт, CORS, БД). Боты, ключи и
 * прочее добавляют модули, которым они нужны; полный список переменных —
 * sites-backend/.env.example и doc/DEPLOYMENT.md, раздел «Бэкенд
 * клиентских сайтов (sites-backend)».
 */

import { devFakeGeminiProblem } from './dev-ai-env';
import { widgetOrigin } from './widget-env';

export interface SitesConfig {
  nodeEnv: string;
  port: number;
  /** Разрешённые Origin для CORS; запись `*.vercel.app` — подстановка. */
  corsOrigins: string[];
  /** Пулерная строка Postgres (Supabase, порт 6543) — для приложения. */
  databaseUrl: string | undefined;
  /** Э2: origin загрузчика/iframe/API виджета (ASSIST_WIDGET_ORIGIN). */
  widgetOrigin: string;
  /** Ошибка: dev-заглушка Gemini включена в production (dev-ai-env.ts). */
  devFakeGeminiProblem?: string | null;
}

export function loadConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): SitesConfig {
  return {
    nodeEnv: env.NODE_ENV || 'development',
    port: parseInt(env.PORT || '3100', 10),
    // Через запятую — чтобы одним значением покрыть и прод-TMA, и превью
    // Vercel (`*.vercel.app`), как у backend.
    //
    // Плюс адреса веб-кабинета (WEB_CABINET_ORIGINS, Э0-W): фронт ходит
    // через same-origin прокси, но браузер всё равно шлёт `Origin` на POST,
    // и CORS-мидлвар отверг бы такой запрос раньше гварда. Один список
    // вместо «не забудьте продублировать домен в CORS_ORIGIN».
    corsOrigins: [
      ...splitList(env.CORS_ORIGIN || 'http://localhost:5174'),
      ...splitList(env.WEB_CABINET_ORIGINS),
    ],
    databaseUrl: env.SITES_DATABASE_URL || undefined,
    widgetOrigin: widgetOrigin(env),
    devFakeGeminiProblem: devFakeGeminiProblem(env),
  };
}

function splitList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

/**
 * Без базы в проде сервис бесполезен, и лучше упасть на старте с понятной
 * фразой, чем отвечать 500 на каждом запросе.
 */
export function validateConfiguration(config: SitesConfig): void {
  if (config.nodeEnv === 'production' && !config.databaseUrl) {
    throw new Error(
      'Не задана SITES_DATABASE_URL — пулерная строка Postgres (см. doc/DEPLOYMENT.md, раздел sites-backend)',
    );
  }
  if (config.devFakeGeminiProblem) {
    throw new Error(config.devFakeGeminiProblem);
  }
  if (!Number.isInteger(config.port) || config.port <= 0) {
    throw new Error(
      `PORT должен быть положительным числом, а не «${config.port}»`,
    );
  }
}
