/**
 * Всё глобальное приложения — в одной функции: её же зовёт тест
 * приложения (app.setup.spec.ts), чтобы проверять ТОТ ЖЕ конверт, фильтр,
 * валидацию и CORS, что на проде, а не их копию.
 */

import { INestApplication, ValidationPipe } from '@nestjs/common';
import {
  json,
  raw,
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
import { VOICE_DEFAULTS } from './modules/assist-site-voice/voice-config';
import { VOICE_CONTROL_DEFAULTS } from './modules/assist-site-voice-control/voice-control-config';
import { ADMIN_STT } from './modules/assist-admin-voice/admin-stt';
import {
  VOICE_MAP_IMPORT_PATH,
  voiceMapImportJson,
} from './modules/assist-site-voice-map/import-body';

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
export const WIDGET_BEACON_PATHS = [
  '/widget/v1/event',
  '/widget/v1/goal',
  // Э3-бис: итог просмотра и включение в эксперимент (sendBeacon при скрытии).
  '/widget/v1/pv',
  '/widget/v1/exp',
];
export const SMALL_BODY_LIMIT = '4kb';
/**
 * Э-С Ш5: системный API знаний сайта подписан HMAC по СЫРОМУ телу
 * (assist-site-knowledge-api) — тело строкой любого Content-Type, свой
 * потолок (документ ≤ 96 КБ в JSON); JSON разбирает сервис после подписи.
 */
export const KNOWLEDGE_API_PATH = '/assist/v1/sites/:id/knowledge';
export const KNOWLEDGE_API_BODY_LIMIT = '128kb';
/**
 * Э-С Ш1 (П-С3): внутренний API обучалки генератора подписан HMAC по СЫРОМУ
 * телу (internal-sites/tutorial-hmac.guard.ts) — по той же причине, что
 * вебхук целей: тело приходит строкой (≤ 8 КБ), JSON разбирает гвард ПОСЛЕ
 * проверки подписи.
 */
export const INTERNAL_SITES_PATH = '/internal/sites';
export const INTERNAL_SITES_BODY_LIMIT = '8kb';
/** Э-С Ш2: хранилище учётных данных — куки сессии до 256 КБ (свой потолок). */
export const INTERNAL_CREDENTIALS_PATH = '/internal/sites/credentials';
export const INTERNAL_CREDENTIALS_BODY_LIMIT = '320kb';
/** Э-С Ш4: карта интерфейса от Flow-QA — снимок с кандидатами (свой потолок). */
export const INTERNAL_QA_UI_MAP_PATH = '/internal/sites/qa/ui-map';
export const INTERNAL_QA_UI_MAP_BODY_LIMIT = '64kb';
/** Ш5(5): полный набор роликов сайта (до 60, ≈ 40 КБ) — свой потолок. */
export const INTERNAL_SITE_VIDEOS_PATH = '/internal/sites/tutorial/site-videos';
export const INTERNAL_SITE_VIDEOS_BODY_LIMIT = '64kb';
/**
 * Э-С Ш3: канал браузерного воркера подписан HMAC по СЫРОМУ телу
 * (internal-worker/worker-hmac.guard.ts) — тело строкой; общий потолок —
 * под артефакт (кадр ≤ 1,5 МБ в base64), потолок каждого маршрута (8 КБ /
 * 384 КБ / 2,2 МБ) держит гвард.
 */
export const INTERNAL_WORKER_PATH = '/internal/worker';
export const INTERNAL_WORKER_BODY_LIMIT = '2300kb';

/**
 * Э5: запись вопроса голосом приходит сырыми байтами (`Content-Type:
 * audio/*`, ≤ 1 МБ — VOICE_DEFAULTS.maxAudioBytes): без multipart и base64
 * (+33%). Больше потолка или не тот тип — отказ AUDIO_INVALID в общем
 * конверте ещё до маршрута (тело дальше не читается).
 */
export const WIDGET_VOICE_PATH = '/widget/v1/voice';

/**
 * Э6-бис (аудит 03.10.2026): маршруты голосового плана (`/widget/v1/ui-plan`
 * и его `:id/confirm|step|stop|resume`) — JSON ≤ 96 КБ
 * (VOICE_CONTROL_DEFAULTS.maxBodyBytes: снимок ≤ 150 элементов), а не
 * общие 100 КБ Nest. Больше — 413 `UI_PLAN_TOO_LARGE` в общем конверте до
 * маршрута (тело дальше не читается, сессия и лимиты не трогаются).
 */
export const WIDGET_UI_PLAN_PATH = '/widget/v1/ui-plan';

/**
 * Э6-бис (б): голосовое управление «Админкой» — запись команды сотрудника
 * (`/assist-admin/v1/voice`, `audio/*` ≤ 1 МБ, Buffer только в памяти
 * запроса) и план/мастер (`/assist-admin/v1/ui-plan*`, `…/voice-test/*` —
 * JSON ≤ 96 КБ, как у «Сайта»; больше — 413 `ADMIN_VC_TOO_LARGE`).
 */
export const ADMIN_VOICE_PATH = '/assist-admin/v1/voice';
export const ADMIN_UI_PLAN_PATHS = [
  '/assist-admin/v1/ui-plan',
  '/assist-admin/v1/voice-test',
];

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
  const knowledgeApiText = text({
    type: () => true,
    limit: KNOWLEDGE_API_BODY_LIMIT,
  });
  app.use(
    KNOWLEDGE_API_PATH,
    function knowledgeApiRawText(
      req: Request,
      res: Response,
      next: NextFunction,
    ) {
      knowledgeApiText(req, res, next);
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
  // Э-С Ш2: раньше общего `/internal/sites` — разобранное тело (`_body`)
  // следующий парсер не трогает, и потолок здесь свой.
  const credentialsText = text({
    type: () => true,
    limit: INTERNAL_CREDENTIALS_BODY_LIMIT,
  });
  app.use(
    INTERNAL_CREDENTIALS_PATH,
    function internalCredentialsRawText(
      req: Request,
      res: Response,
      next: NextFunction,
    ) {
      credentialsText(req, res, next);
    },
  );
  const qaUiMapText = text({
    type: () => true,
    limit: INTERNAL_QA_UI_MAP_BODY_LIMIT,
  });
  app.use(
    INTERNAL_QA_UI_MAP_PATH,
    function internalQaUiMapRawText(
      req: Request,
      res: Response,
      next: NextFunction,
    ) {
      qaUiMapText(req, res, next);
    },
  );
  const workerText = text({
    type: () => true,
    limit: INTERNAL_WORKER_BODY_LIMIT,
  });
  app.use(
    INTERNAL_WORKER_PATH,
    function internalWorkerRawText(
      req: Request,
      res: Response,
      next: NextFunction,
    ) {
      workerText(req, res, next);
    },
  );
  const siteVideosText = text({
    type: () => true,
    limit: INTERNAL_SITE_VIDEOS_BODY_LIMIT,
  });
  app.use(
    INTERNAL_SITE_VIDEOS_PATH,
    function internalSiteVideosRawText(
      req: Request,
      res: Response,
      next: NextFunction,
    ) {
      siteVideosText(req, res, next);
    },
  );
  const internalText = text({
    type: () => true,
    limit: INTERNAL_SITES_BODY_LIMIT,
  });
  app.use(
    INTERNAL_SITES_PATH,
    function internalSitesRawText(
      req: Request,
      res: Response,
      next: NextFunction,
    ) {
      internalText(req, res, next);
    },
  );
  const voiceRaw = raw({
    type: (req) => /^audio\//i.test(String(req.headers['content-type'] ?? '')),
    limit: VOICE_DEFAULTS.maxAudioBytes,
  });
  app.use(
    WIDGET_VOICE_PATH,
    function widgetVoiceRaw(req: Request, res: Response, next: NextFunction) {
      voiceRaw(req, res, (err?: unknown) => {
        if (!err) return next();
        res.status(400).json({
          success: false,
          error: {
            code: 'AUDIO_INVALID',
            message: 'Запись не подходит — повторите или напишите текстом',
          },
          meta: {
            timestamp: new Date().toISOString(),
            path: WIDGET_VOICE_PATH,
          },
        });
      });
    },
  );
  const uiPlanJson = json({ limit: VOICE_CONTROL_DEFAULTS.maxBodyBytes });
  app.use(
    WIDGET_UI_PLAN_PATH,
    function widgetUiPlanJson(req: Request, res: Response, next: NextFunction) {
      uiPlanJson(req, res, (err?: unknown) => {
        if (!err) return next();
        const tooLarge = (err as { type?: string }).type === 'entity.too.large';
        res.status(tooLarge ? 413 : 400).json({
          success: false,
          error: tooLarge
            ? {
                code: 'UI_PLAN_TOO_LARGE',
                message: 'Страница слишком большая для голосового управления',
              }
            : { code: 'BAD_REQUEST', message: 'Неверный запрос' },
          meta: {
            timestamp: new Date().toISOString(),
            path: WIDGET_UI_PLAN_PATH,
          },
        });
      });
    },
  );
  const adminVoiceRaw = raw({
    type: (req) => /^audio\//i.test(String(req.headers['content-type'] ?? '')),
    limit: ADMIN_STT.maxAudioBytes,
  });
  app.use(
    ADMIN_VOICE_PATH,
    function adminVoiceRawAudio(
      req: Request,
      res: Response,
      next: NextFunction,
    ) {
      adminVoiceRaw(req, res, (err?: unknown) => {
        if (!err) return next();
        res.status(400).json({
          success: false,
          error: {
            code: 'ADMIN_VC_AUDIO_INVALID',
            message: 'Запись не подходит — повторите или напишите текстом',
          },
          meta: { timestamp: new Date().toISOString(), path: ADMIN_VOICE_PATH },
        });
      });
    },
  );
  const adminPlanJson = json({ limit: VOICE_CONTROL_DEFAULTS.maxBodyBytes });
  for (const path of ADMIN_UI_PLAN_PATHS) {
    app.use(
      path,
      function adminUiPlanJson(
        req: Request,
        res: Response,
        next: NextFunction,
      ) {
        adminPlanJson(req, res, (err?: unknown) => {
          if (!err) return next();
          const tooLarge =
            (err as { type?: string }).type === 'entity.too.large';
          res.status(tooLarge ? 413 : 400).json({
            success: false,
            error: tooLarge
              ? {
                  code: 'ADMIN_VC_TOO_LARGE',
                  message: 'Страница слишком большая для голосового управления',
                }
              : { code: 'BAD_REQUEST', message: 'Неверный запрос' },
            meta: { timestamp: new Date().toISOString(), path },
          });
        });
      },
    );
  }
  // Э6-тер (хвост аудита (4)): импорт голосовой карты — до 1 МБ, только здесь.
  app.use(VOICE_MAP_IMPORT_PATH, voiceMapImportJson());
  app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(new ResponseInterceptor());
}
