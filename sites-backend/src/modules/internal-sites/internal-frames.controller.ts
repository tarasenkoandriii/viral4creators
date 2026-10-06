/**
 * Кадры обучалки браузерным воркером (Э-С Ш3) — канал генератора, подпись
 * обучалки (`TutorialHmacGuard`):
 *
 *   POST /internal/sites/tutorial/frames/request { telegramId, url, frames?, viewport? } → { jobId, status }
 *   POST /internal/sites/tutorial/frames/status  { telegramId, jobId } → статус и подписанные ссылки (≤ 15 мин)
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
import { JOB_ID_RE, type BrowserViewport } from '../browser-jobs/protocol';
import { InternalFramesService } from './internal-frames.service';
import { parseTelegramId } from './internal-sites.service';
import { InternalRequest, TutorialHmacGuard } from './tutorial-hmac.guard';

const InternalBody = createParamDecorator(
  (_d: unknown, ctx: ExecutionContext): unknown =>
    ctx.switchToHttp().getRequest<InternalRequest>().internalBody,
);

function bad(message: string): BadRequestException {
  return new BadRequestException({
    error: 'INTERNAL_BAD_BODY',
    code: 'INTERNAL_BAD_BODY',
    message,
  });
}

function obj(b: unknown, allowed: string[]): Record<string, unknown> {
  if (!b || typeof b !== 'object' || Array.isArray(b)) {
    throw bad('Ожидается JSON-объект');
  }
  const o = b as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (!allowed.includes(k)) throw bad(`Лишнее поле «${k}»`);
  }
  return o;
}

@Controller('internal/sites/tutorial/frames')
@PublicRoute(
  'внутренний API обучалки генератора: HMAC с меткой времени и id (SITES_TUTORIAL_HMAC_SECRET)',
)
@UseGuards(TutorialHmacGuard)
export class InternalFramesController {
  constructor(private readonly svc: InternalFramesService) {}

  @Post('request')
  @HttpCode(200)
  request(@InternalBody() b: unknown) {
    const o = obj(b, ['telegramId', 'url', 'frames', 'viewport']);
    if (typeof o.url !== 'string' || o.url.length > 2000) throw bad('url');
    const frames = o.frames === undefined ? 3 : o.frames;
    if (
      typeof frames !== 'number' ||
      !Number.isInteger(frames) ||
      frames < 1 ||
      frames > 10
    ) {
      throw bad('frames: 1…10');
    }
    return this.svc.request(parseTelegramId(o.telegramId), {
      url: o.url,
      frames,
      viewport: (o.viewport ?? 'mobile') as BrowserViewport,
    });
  }

  @Post('status')
  @HttpCode(200)
  status(@InternalBody() b: unknown) {
    const o = obj(b, ['telegramId', 'jobId']);
    if (typeof o.jobId !== 'string' || !JOB_ID_RE.test(o.jobId))
      throw bad('jobId');
    return this.svc.status(parseTelegramId(o.telegramId), o.jobId);
  }
}
