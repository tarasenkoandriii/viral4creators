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
import { adminWidgetOrigin } from './admin-env';
import { editorWidgetOrigin } from './editor-env';

export interface SitesConfig {
  nodeEnv: string;
  port: number;
  /** Разрешённые Origin для CORS; запись `*.vercel.app` — подстановка. */
  corsOrigins: string[];
  /** Пулерная строка Postgres (Supabase, порт 6543) — для приложения. */
  databaseUrl: string | undefined;
  /** Э2: origin загрузчика/iframe/API виджета (ASSIST_WIDGET_ORIGIN). */
  widgetOrigin: string;
  /** Э7: origin iframe «Админки» (ASSIST_ADMIN_WIDGET_ORIGIN, отдельный от виджета). */
  adminWidgetOrigin?: string;
  /** Э6-тер: origin iframe панели редактора голосовой карты (ASSIST_EDITOR_WIDGET_ORIGIN, `we.`). */
  editorWidgetOrigin?: string;
  /** Ошибка: dev-заглушка Gemini включена в production (dev-ai-env.ts). */
  devFakeGeminiProblem?: string | null;
  /** Предупреждение: прод вне Vercel без TRUSTED_PROXY_CIDRS (П-С1). */
  clientIpProblem?: string | null;
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
    adminWidgetOrigin: adminWidgetOrigin(env),
    editorWidgetOrigin: editorWidgetOrigin(env),
    devFakeGeminiProblem: devFakeGeminiProblem(env),
    clientIpProblem: clientIpEnvProblem(env),
  };
}

/**
 * П-С1 (заход 10): production вне Vercel без `TRUSTED_PROXY_CIDRS` —
 * `clientIp` берёт адрес сокета; за обратным прокси это адрес прокси, и
 * все лимиты по адресу становятся общими для всех посетителей. Подделки
 * адреса здесь нет (XFF не читается), поэтому это громкое предупреждение
 * на старте, а не отказ: признак Vercel (`VERCEL`) — системная переменная,
 * которую в настройках проекта можно скрыть, и отказ уронил бы прод.
 * Сервис без прокси перед собой — `TRUSTED_PROXY_CIDRS=none` (любая
 * не-подсеть = «прокси нет»): решение явное, предупреждения нет.
 */
export function clientIpEnvProblem(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (env.NODE_ENV !== 'production') return null;
  if (env.VERCEL?.trim() || env.TRUSTED_PROXY_CIDRS?.trim()) return null;
  return (
    'TRUSTED_PROXY_CIDRS не задан, а VERCEL нет: адрес клиента — адрес соединения; ' +
    'за прокси (Traefik/nginx) задайте его подсети, без прокси — TRUSTED_PROXY_CIDRS=none ' +
    '(doc/DEPLOYMENT.md, sites-backend)'
  );
}

/** Предупреждения конфигурации: старт не падает, но пишет в журнал ошибок. */
export function configurationWarnings(config: SitesConfig): string[] {
  return config.clientIpProblem ? [config.clientIpProblem] : [];
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
