/**
 * Внутренний API карты интерфейса для Flow-QA (Э-С Ш4). Подпись — HMAC с
 * меткой времени и id, свой секрет `SITES_QA_HMAC_SECRET` и вызывающий
 * `qa-flow` (qa-hmac.guard.ts); тело ≤ 64 КБ строкой, JSON — после подписи.
 *
 *   POST /internal/sites/qa/ui-map/read   { telegramId, siteId, url?, viewport? }
 *        без url — страницы карты сайта; с url — слитые элементы страницы
 *        (кандидаты, устойчивость, уверенность, источники, промахи по виду)
 *        и текущие снимки источников (версия, вид, когда сняты)
 *   POST /internal/sites/qa/ui-map/write  { telegramId, siteId, url, viewport, elements[] }
 *        снимок прогона QA (источник `qa`): ≤ 100 элементов в теле, в карту
 *        — ≤ 60 после чистки; пустой массив — снимок QA страницы снимается
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
import { InternalUiMapService } from './internal-ui-map.service';
import { QaHmacGuard } from './qa-hmac.guard';
import type { InternalRequest } from './tutorial-hmac.guard';

const InternalBody = createParamDecorator(
  (_d: unknown, ctx: ExecutionContext): unknown =>
    ctx.switchToHttp().getRequest<InternalRequest>().internalBody,
);

const ID = /^[A-Za-z0-9_-]{1,64}$/;

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

function siteId(v: unknown): string {
  if (typeof v !== 'string' || !ID.test(v)) throw bad('siteId — id');
  return v;
}

function url(v: unknown): string {
  if (typeof v !== 'string' || v.length > 2048)
    throw bad('url — строка до 2048');
  return v;
}

@Controller('internal/sites/qa/ui-map')
@PublicRoute(
  'внутренний API Flow-QA (Ш4: карта интерфейса): HMAC с меткой времени и id (SITES_QA_HMAC_SECRET)',
)
@UseGuards(QaHmacGuard)
export class InternalUiMapController {
  constructor(private readonly svc: InternalUiMapService) {}

  @Post('read')
  @HttpCode(200)
  read(@InternalBody() b: unknown) {
    const o = obj(b, ['telegramId', 'siteId', 'url', 'viewport']);
    const viewport =
      o.viewport === undefined ? null : parseUiViewport(o.viewport);
    if (o.viewport !== undefined && !viewport)
      throw bad('viewport — desktop | mobile | any');
    return this.svc.read(
      parseTelegramId(o.telegramId),
      siteId(o.siteId),
      o.url === undefined ? null : url(o.url),
      viewport,
    );
  }

  @Post('write')
  @HttpCode(200)
  write(@InternalBody() b: unknown) {
    const o = obj(b, ['telegramId', 'siteId', 'url', 'viewport', 'elements']);
    const viewport = parseUiViewport(o.viewport);
    if (!viewport) throw bad('viewport — desktop | mobile | any');
    if (!Array.isArray(o.elements) || o.elements.length > 100)
      throw bad('elements — массив до 100');
    return this.svc.write(
      parseTelegramId(o.telegramId),
      siteId(o.siteId),
      url(o.url),
      viewport,
      o.elements,
    );
  }
}
