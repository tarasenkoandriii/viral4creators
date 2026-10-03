import type {
  CorsOptions,
  CorsOptionsDelegate,
} from '@nestjs/common/interfaces/external/cors-options.interface';
import type { NextFunction, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { matchesAllowedOrigin } from '../shared/cors-origin-match';

type OriginCallback = (err: Error | null, allow?: boolean) => void;

/**
 * Отказ CORS по списку. Пакет `cors` передаёт ошибку колбэка в `next(err)`
 * — раньше она доходила до обработчика express по умолчанию и давала 500
 * (интеграция Э2: `POST /public/landing/event` с чужой страницы). Отказ
 * оставляем ДО обработчика маршрута (чужая страница не должна запускать
 * его простым запросом text/plain — защита для маршрутов с cookie), но
 * отвечаем 403 в общем конверте — `corsDeniedHandler` ниже.
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
  const url = req.url ?? '';
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

/**
 * Проверка Origin для `app.enableCors` — та же логика, что у backend
 * (сравнение — общий модуль shared/cors-origin-match.ts): запрос без
 * Origin (сервер-сервер, curl, health) пропускается, остальное — по
 * списку CORS_ORIGIN, где `*.vercel.app` покрывает превью.
 */
export function corsOriginCheck(allowed: readonly string[]) {
  return (requestOrigin: string | undefined, callback: OriginCallback) => {
    if (!requestOrigin) return callback(null, true);
    const ok = matchesAllowedOrigin(requestOrigin, allowed);
    callback(ok ? null : new CorsOriginDeniedError(), ok);
  };
}

/**
 * Э2 (координатор): маршруты виджета живут по своим правилам CORS.
 *  - Открытые ВСЕМ сайтам, без cookie: конфиг виджета (загрузчик на сайте
 *    заказчика читает его fetch'ем, ТЗ §3-бис.1), пинг и картинки — это
 *    публичные данные бренда, допуск решают session/chat (§4.13 п.1).
 *  - Остальные `/widget/v1/*` и `/w/v1/*` зовёт iframe с origin виджета
 *    (тот же origin через rewrite Vercel-проекта `widget`): разрешён только
 *    он, с credentials (CHIPS-cookie указателя). Чужой origin — без
 *    CORS-заголовков (браузер не отдаст ответ), а не 500; отказ по
 *    существу — гвард виджета (ORIGIN_DENIED).
 *  - Всё прочее — список CORS_ORIGIN, как раньше.
 */
const WIDGET_OPEN_PATHS = [
  /^\/widget\/v1\/config(\?|$)/,
  /^\/widget\/v1\/ping(\?|$)/,
  /^\/widget\/v1\/asset\/[^/?]+(\?|$)/,
];
/**
 * Э3 (координатор): маршруты, которые зовёт СТРАНИЦА заказчика (загрузчик в
 * origin сайта) — счётчики событий, цели, режим выбора цели (§4.16,
 * §5-тер.14). Origin — любой сайт (CORS отражает его, без cookie);
 * допуск решает гвард по pk + точному verified public-хосту (W), как у
 * чата. Из iframe (origin виджета) эти же маршруты зовутся без credentials.
 */
const WIDGET_PAGE_PATHS = [
  /^\/widget\/v1\/event(\?|$)/,
  /^\/widget\/v1\/goal(\?|$)/,
  /^\/widget\/v1\/goal-picker\/(session|pick)(\?|$)/,
];
const WIDGET_PATHS = /^\/(widget|w)\/v1\//;
/**
 * Э7: чат сотрудника «Админки» — iframe на ОТДЕЛЬНОМ origin `wa.` (§4.12,
 * У-13), API через тот же rewrite Vercel. Браузер шлёт `Origin` и на
 * same-origin POST — без своего правила общий список CORS отверг бы его
 * (403 `ORIGIN_DENIED`). Отражается ТОЛЬКО origin «Админки», без cookie
 * (сессия — заголовок); чужой origin — без CORS-заголовков.
 */
const ADMIN_PATHS = /^\/(assist-admin|wa)\/v1\//;

const METHODS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'];

export function corsOptionsDelegate(cfg: {
  corsOrigins: readonly string[];
  widgetOrigin: string;
  adminWidgetOrigin?: string;
}) {
  const general = corsOriginCheck(cfg.corsOrigins);
  const delegate: CorsOptionsDelegate<Pick<Request, 'url' | 'headers'>> = (
    req,
    callback: (err: Error | null, options: CorsOptions) => void,
  ) => {
    const url = req.url ?? '';
    if (WIDGET_OPEN_PATHS.some((re) => re.test(url))) {
      return callback(null, {
        origin: '*',
        methods: ['GET', 'OPTIONS'],
        credentials: false,
        maxAge: 600,
      });
    }
    if (WIDGET_PAGE_PATHS.some((re) => re.test(url))) {
      return callback(null, {
        origin: true,
        methods: ['POST', 'OPTIONS'],
        credentials: false,
        maxAge: 600,
      });
    }
    if (ADMIN_PATHS.test(url)) {
      const origin = req.headers.origin;
      return callback(null, {
        origin:
          cfg.adminWidgetOrigin && origin === cfg.adminWidgetOrigin
            ? origin
            : false,
        methods: METHODS,
        credentials: false,
      });
    }
    if (WIDGET_PATHS.test(url)) {
      const origin = req.headers.origin;
      return callback(null, {
        origin: origin === cfg.widgetOrigin ? origin : false,
        methods: METHODS,
        credentials: true,
      });
    }
    // Авторизация TMA — заголовок с initData, cookie не нужны; но клиент,
    // собранный по образцу frontend/src/services/api.ts, шлёт запросы с
    // `withCredentials: true`, и без этого заголовка браузер отвергнет
    // ответ (урок М-4.4 backend). Origin всё равно сверяется по списку.
    return callback(null, {
      origin: general,
      methods: METHODS,
      credentials: true,
    });
  };
  return delegate;
}
