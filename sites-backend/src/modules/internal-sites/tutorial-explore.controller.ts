/**
 * Раунд исследователя обучалки на браузерном воркере (Ш3-хвост (3)) — канал
 * генератора, подпись обучалки (`TutorialHmacGuard`):
 *
 *   POST /internal/sites/credentials/tutorial-explore/seal-key {} → { publicKey }
 *   POST …/request { subject, url, allowedOrigin, clicks[≤1], fills?[≤10],
 *                    replay?, session|null, replyKey, nonce, videoFrame,
 *                    registry? } → { jobId, status, mode }
 *   POST …/status  { subject, jobId, telegramId? } → статус, результат, ссылки (≤ 15 мин)
 *   POST …/cancel  { subject, jobId, telegramId?, running? } → { jobId, status }
 *                  (по умолчанию — только ожидающее; `running` — и идущее)
 *
 * Префикс — канала хранилища учётных данных (`/internal/sites/credentials`):
 * тело `request` несёт сессию черновика (конверт cookie jar до 200 КБ), а у
 * этого префикса свой потолок тела 320 КБ (`app.setup.ts`, гвард) — общий
 * потолок обучалки 8 КБ сессию не вместит. Сессия — секрет входа, ей там и
 * место; открытого текста в канале нет (только конверт под ключ воркера).
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
import { JOB_ID_RE } from '../browser-jobs/protocol';
import { parseTelegramId } from './internal-sites.service';
import { InternalRequest, TutorialHmacGuard } from './tutorial-hmac.guard';
import {
  TutorialExploreService,
  type ExploreRequest,
} from './tutorial-explore.service';

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

function obj(
  b: unknown,
  allowed: string[],
  where = 'тело',
): Record<string, unknown> {
  if (!b || typeof b !== 'object' || Array.isArray(b)) {
    throw bad(`${where}: ожидается JSON-объект`);
  }
  const o = b as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (!allowed.includes(k)) throw bad(`Лишнее поле «${k}»`);
  }
  return o;
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function str(v: unknown, field: string, max: number): string {
  if (typeof v !== 'string' || v.length === 0 || v.length > max)
    throw bad(field);
  return v;
}

function strOrNull(v: unknown, field: string, max: number): string | null {
  return v === null || v === undefined ? null : str(v, field, max);
}

function telegramOf(v: unknown): bigint | null {
  return v === undefined || v === null ? null : parseTelegramId(v);
}

export function parseExploreRequest(b: unknown): ExploreRequest {
  const o = obj(b, [
    'subject',
    'url',
    'allowedOrigin',
    'clicks',
    'session',
    'replyKey',
    'nonce',
    'videoFrame',
    'registry',
    'fills',
    'replay',
  ]);
  if (!Array.isArray(o.clicks) || o.clicks.some((c) => typeof c !== 'string'))
    throw bad('clicks');
  if (typeof o.videoFrame !== 'boolean') throw bad('videoFrame');
  // Форма полей ввода и шагов — строго в протоколе очереди (`parseJobParams`).
  if (o.fills !== undefined && !Array.isArray(o.fills)) throw bad('fills');
  if (o.replay !== undefined && o.replay !== null && !Array.isArray(o.replay))
    throw bad('replay');
  let registry: ExploreRequest['registry'] = null;
  if (o.registry !== undefined && o.registry !== null) {
    const r = obj(
      o.registry,
      ['telegramId', 'testAccountId', 'needUsername', 'pick'],
      'registry',
    );
    if (typeof r.testAccountId !== 'string' || !ID_RE.test(r.testAccountId))
      throw bad('registry.testAccountId');
    if (typeof r.needUsername !== 'boolean') throw bad('registry.needUsername');
    let pick: NonNullable<ExploreRequest['registry']>['pick'] = null;
    if (r.pick !== undefined && r.pick !== null) {
      const p = obj(
        r.pick,
        ['usernameSelector', 'passwordSelector', 'submitSelector'],
        'registry.pick',
      );
      pick = {
        usernameSelector: strOrNull(p.usernameSelector, 'pick', 400),
        passwordSelector: strOrNull(p.passwordSelector, 'pick', 400),
        submitSelector: strOrNull(p.submitSelector, 'pick', 400),
      };
    }
    registry = {
      telegramId: parseTelegramId(r.telegramId),
      testAccountId: r.testAccountId,
      needUsername: r.needUsername,
      pick,
    };
  }
  return {
    subject: str(o.subject, 'subject', 56),
    url: str(o.url, 'url', 2000),
    allowedOrigin: str(o.allowedOrigin, 'allowedOrigin', 300),
    clicks: o.clicks as string[],
    session: strOrNull(o.session, 'session', 210_000),
    replyKey: str(o.replyKey, 'replyKey', 64),
    nonce: str(o.nonce, 'nonce', 64),
    videoFrame: o.videoFrame,
    registry,
    fills: (o.fills as unknown[] | undefined) ?? [],
    replay: (o.replay as unknown[] | null | undefined) ?? null,
  };
}

@Controller('internal/sites/credentials/tutorial-explore')
@PublicRoute(
  'внутренний API обучалки генератора: HMAC с меткой времени и id (SITES_TUTORIAL_HMAC_SECRET)',
)
@UseGuards(TutorialHmacGuard)
export class TutorialExploreController {
  constructor(private readonly svc: TutorialExploreService) {}

  @Post('seal-key')
  @HttpCode(200)
  sealKey(@InternalBody() b: unknown) {
    obj(b ?? {}, []);
    return this.svc.sealKey();
  }

  @Post('request')
  @HttpCode(200)
  request(@InternalBody() b: unknown) {
    return this.svc.request(parseExploreRequest(b));
  }

  @Post('status')
  @HttpCode(200)
  status(@InternalBody() b: unknown) {
    const o = obj(b, ['subject', 'jobId', 'telegramId']);
    if (typeof o.jobId !== 'string' || !JOB_ID_RE.test(o.jobId))
      throw bad('jobId');
    return this.svc.status(
      str(o.subject, 'subject', 56),
      o.jobId,
      telegramOf(o.telegramId),
    );
  }

  @Post('cancel')
  @HttpCode(200)
  cancel(@InternalBody() b: unknown) {
    const o = obj(b, ['subject', 'jobId', 'telegramId', 'running']);
    if (typeof o.jobId !== 'string' || !JOB_ID_RE.test(o.jobId))
      throw bad('jobId');
    if (o.running !== undefined && typeof o.running !== 'boolean')
      throw bad('running');
    return this.svc.cancel(
      str(o.subject, 'subject', 56),
      o.jobId,
      telegramOf(o.telegramId),
      o.running === true,
    );
  }
}
