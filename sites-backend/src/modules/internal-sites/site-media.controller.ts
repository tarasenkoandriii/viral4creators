/**
 * Внутренний API Э6 для обучалки генератора (ТЗ помощника §4.11, §4.12).
 * Зовёт ТОЛЬКО backend/ (`modules/client-site-media`), подпись — тот же
 * tutorial-hmac.guard.ts (секрет SITES_TUTORIAL_HMAC_SECRET, вызывающий
 * `generator-tutorial`), тело ≤ 8 КБ строкой, JSON — после подписи.
 *
 *   POST /internal/sites/tutorial/site-link    { telegramId, siteId } → можно ли привязать черновик
 *   POST /internal/sites/tutorial/site-videos  { siteId, asOf, videos[] } → полный набор роликов сайта
 *        (`asOf` — мс часов генератора, взятые ДО чтения его базы; набор
 *        старше последнего принятого → 200 `{ stale: true }`, без изменений)
 *   POST /internal/sites/tutorial/ui-map       { telegramId, siteId, url, elements[], viewport? } → карта страницы
 *        (Э-С Ш4: `viewport` — desktop|mobile|any, по умолчанию mobile —
 *        окно исследователя обучалки; элементы — форма Э6 или с
 *        `candidates`/`assistId`/`role`, site-core/ui-map/ui-map-model.ts)
 *
 * Отдельный файл (не internal-sites.controller.ts Ш1): маршруты Э6 —
 * свой контроллер и свой модуль `InternalSiteMediaModule` в той же папке
 * (лист графа: берёт только site-core).
 */
import {
  BadRequestException,
  Controller,
  HttpCode,
  Post,
  UseGuards,
  createParamDecorator,
  type ExecutionContext,
} from '@nestjs/common';
import { PublicRoute } from '../telegram-auth/allow-apps.decorator';
import { parseUiViewport } from '../site-core/ui-map/ui-map-model';
import { parseTelegramId } from './internal-sites.service';
import {
  InternalSiteMediaService,
  SYNC_VIDEOS_MAX,
  type SyncVideoInput,
} from './site-media.service';
import { InternalRequest, TutorialHmacGuard } from './tutorial-hmac.guard';

const InternalBody = createParamDecorator(
  (_d: unknown, ctx: ExecutionContext): unknown =>
    ctx.switchToHttp().getRequest<InternalRequest>().internalBody,
);

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const LOCALE = /^[a-z]{2}(?:-[A-Za-z]{2})?$/;
const HOST = /^[a-z0-9.-]{1,253}$/i;

function bad(message: string): BadRequestException {
  return new BadRequestException({
    error: 'INTERNAL_BAD_BODY',
    code: 'INTERNAL_BAD_BODY',
    message,
  });
}

function obj(b: unknown, keys: string[]): Record<string, unknown> {
  if (!b || typeof b !== 'object' || Array.isArray(b)) {
    throw bad('Ожидается объект JSON');
  }
  const o = b as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (!keys.includes(k)) throw bad(`Лишнее поле «${k}»`);
  }
  return o;
}

function id(v: unknown, name: string): string {
  if (typeof v !== 'string' || !ID.test(v)) throw bad(`${name} — id`);
  return v;
}

export function parseSyncVideo(v: unknown): SyncVideoInput {
  const o = obj(v, [
    'externalId',
    'draftId',
    'ownerTelegramId',
    'title',
    'locale',
    'durationMs',
    'url',
    'requiresLogin',
    'stepHosts',
  ]);
  if (typeof o.title !== 'string' || !o.title.trim() || o.title.length > 200)
    throw bad('title — строка до 200');
  if (typeof o.locale !== 'string' || !LOCALE.test(o.locale))
    throw bad('locale — код языка');
  if (
    o.durationMs !== null &&
    (typeof o.durationMs !== 'number' ||
      !Number.isInteger(o.durationMs) ||
      o.durationMs < 0 ||
      o.durationMs > 3_600_000)
  )
    throw bad('durationMs — целое или null');
  if (typeof o.url !== 'string' || o.url.length > 1000)
    throw bad('url — строка до 1000');
  if (typeof o.requiresLogin !== 'boolean')
    throw bad('requiresLogin — boolean');
  if (
    !Array.isArray(o.stepHosts) ||
    o.stepHosts.length > 10 ||
    o.stepHosts.some((h) => typeof h !== 'string' || !HOST.test(h))
  )
    throw bad('stepHosts — до 10 имён хостов');
  return {
    externalId: id(o.externalId, 'externalId'),
    draftId: id(o.draftId, 'draftId'),
    ownerTelegramId: parseTelegramId(o.ownerTelegramId),
    title: o.title.trim(),
    locale: o.locale,
    durationMs: o.durationMs as number | null,
    url: o.url,
    requiresLogin: o.requiresLogin,
    stepHosts: (o.stepHosts as string[]).map((h) => h.toLowerCase()),
  };
}

@Controller('internal/sites/tutorial')
@PublicRoute(
  'внутренний API обучалки генератора (Э6: ролики и карта интерфейса): HMAC с меткой времени и id (SITES_TUTORIAL_HMAC_SECRET)',
)
@UseGuards(TutorialHmacGuard)
export class InternalSiteMediaController {
  constructor(private readonly svc: InternalSiteMediaService) {}

  @Post('site-link')
  @HttpCode(200)
  link(@InternalBody() b: unknown) {
    const o = obj(b, ['telegramId', 'siteId']);
    return this.svc.link(parseTelegramId(o.telegramId), id(o.siteId, 'siteId'));
  }

  @Post('site-videos')
  @HttpCode(200)
  syncVideos(@InternalBody() b: unknown) {
    const o = obj(b, ['siteId', 'asOf', 'videos']);
    if (
      typeof o.asOf !== 'number' ||
      !Number.isSafeInteger(o.asOf) ||
      o.asOf <= 0
    ) {
      throw bad('asOf — целое число мс > 0');
    }
    if (!Array.isArray(o.videos) || o.videos.length > SYNC_VIDEOS_MAX) {
      throw bad(`videos — массив до ${SYNC_VIDEOS_MAX}`);
    }
    const videos = o.videos.map(parseSyncVideo);
    if (new Set(videos.map((v) => v.externalId)).size !== videos.length) {
      throw bad('externalId повторяется');
    }
    return this.svc.syncVideos(id(o.siteId, 'siteId'), videos, o.asOf);
  }

  @Post('ui-map')
  @HttpCode(200)
  uiMap(@InternalBody() b: unknown) {
    const o = obj(b, ['telegramId', 'siteId', 'url', 'elements', 'viewport']);
    if (typeof o.url !== 'string' || o.url.length > 2048)
      throw bad('url — строка до 2048');
    if (!Array.isArray(o.elements) || o.elements.length > 100)
      throw bad('elements — массив до 100');
    const viewport =
      o.viewport === undefined ? undefined : parseUiViewport(o.viewport);
    if (viewport === null) throw bad('viewport — desktop | mobile | any');
    return this.svc.uiMap(
      parseTelegramId(o.telegramId),
      id(o.siteId, 'siteId'),
      o.url,
      o.elements,
      undefined,
      viewport,
    );
  }
}
