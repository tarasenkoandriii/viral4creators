/**
 * Глобальная настройка приложения backend: префикс, слои express,
 * CORS, pipe/фильтр/интерцептор. Вынесено из `main.ts` (заход 12, аудит
 * P3-1), чтобы тесты проверяли ровно то, что включает `bootstrap()`, —
 * как `configureApp` у sites-backend (`sites-backend/src/app.setup.ts`).
 * `main.ts` зовёт её до `listen()`; `app.setup.spec.ts` — на пробном
 * контроллере.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { json } from 'express';
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { defaultEmptyBody } from './common/express-body-default';
import { matchesAllowedOrigin } from './common/cors-origin-match';
import { CorsOriginDeniedError, corsDeniedHandler } from './common/cors-denied';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { VALIDATION_PIPE_OPTIONS } from './common/validation-pipe';
import type { Configuration } from './config/configuration';
import {
  ADMIN_SESSION_COOKIE_NAME,
  parseCookieHeader,
} from './modules/admin-auth/cookie.util';
import { IMPORT_MAX_BODY_BYTES } from './modules/admin-panel/admin-reddit.routes';

/**
 * P-R-ADM: импорт исследования Reddit из админки — три CSV в одном JSON
 * (≤ 1 МБ); общий JSON-парсер Nest держит 100 КБ. Свой парсер — только на
 * этом пути (`/api/admin/reddit/import/plan|apply`); дальше общий парсер
 * тело не трогает (body-parser 2 видит дочитанный поток).
 *
 * Аудит 15.10.2026 (adm-6): большой парсер стоит ПОСЛЕ CORS (чужой Origin —
 * 403 до чтения тела) и читает тело только при наличии cookie сессии
 * Админки (`admin_session`; проверка наличия — сама сессия проверяется
 * гвардом). Без cookie тело читает общий парсер со своим лимитом, а
 * `AdminSessionGuard` отвечает 401 — как на любом маршруте Админки.
 */
export const ADMIN_REDDIT_IMPORT_PATH = '/api/admin/reddit/import';

/** Есть ли в запросе cookie сессии Админки (без проверки самой сессии). */
export function hasAdminSessionCookie(req: Request): boolean {
  return !!parseCookieHeader(req.headers.cookie)[ADMIN_SESSION_COOKIE_NAME];
}

export function configureApp(
  app: INestApplication,
  config: Pick<Configuration, 'cors'>,
): void {
  // Set global prefix
  app.setGlobalPrefix('api');

  // Заход 12 (Express 5): `req.body` без тела — `{}`, как в Express 4.
  // Первым слоем, до любых парсеров (common/express-body-default.ts).
  app.use(defaultEmptyBody);

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

      // Аудит Админки S3-6: отказ — `CorsOriginDeniedError`, его ловит
      // `corsDeniedHandler` ниже (403 в конверте, а не 500 express).
      callback(isAllowed ? null : new CorsOriginDeniedError(), isAllowed);
    },
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    credentials: true,
  });
  // Сразу за `cors`: его `next(err)` при чужом Origin — 403, не 500.
  app.use(corsDeniedHandler);

  // P-R-ADM: парсер импорта 1 МБ — после CORS и только с cookie сессии
  // Админки (adm-6). Общий парсер Nest ставится позже (при `init()`), так что
  // этот слой всё равно раньше него. Обёртка с СВОИМ именем обязательна:
  // Nest не ставит общий JSON-парсер, если в стеке уже есть слой с именем
  // `jsonParser` (имя функции body-parser), — и JSON перестал бы
  // разбираться на всех маршрутах.
  const importJson = json({ limit: IMPORT_MAX_BODY_BYTES });
  app.use(
    ADMIN_REDDIT_IMPORT_PATH,
    function adminRedditImportJson(
      req: Request,
      res: Response,
      next: NextFunction,
    ) {
      if (!hasAdminSessionCookie(req)) return next();
      importJson(req, res, next);
    },
  );
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
}
