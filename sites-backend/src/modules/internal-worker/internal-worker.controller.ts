/**
 * Внутренний API браузерного воркера (Э-С Ш3) — pull-модель: воркер сам
 * забирает задания, входящих портов у него нет.
 *
 *   POST /internal/worker/v1/jobs/claim        { workerId, kinds[], max }
 *   POST /internal/worker/v1/jobs/heartbeat    { jobId, leaseToken }
 *   POST /internal/worker/v1/jobs/complete     { jobId, leaseToken, result }
 *   POST /internal/worker/v1/jobs/fail         { jobId, leaseToken, code }
 *   POST /internal/worker/v1/jobs/credentials  { jobId, leaseToken } → конверт под ключ воркера
 *   POST /internal/worker/v1/jobs/artifact     { jobId, leaseToken, idx, contentType, width, height, data }
 *
 * Подпись — `WorkerHmacGuard` (свой секрет и вызывающий `browser-worker`).
 * Тело — строгий JSON: лишнее поле — 400.
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
import { BrowserJobsService } from '../browser-jobs/browser-jobs.service';
import {
  BrowserJobKind,
  JOB_ID_RE,
  LEASE_TOKEN_RE,
  WORKER_ID_RE,
  WORKER_LIMITS,
  isBrowserJobKind,
  isWorkerErrorCode,
} from '../browser-jobs/protocol';
import { InternalWorkerService } from './internal-worker.service';
import { WorkerHmacGuard, WorkerRequest } from './worker-hmac.guard';

const Body = createParamDecorator(
  (_d: unknown, ctx: ExecutionContext): unknown =>
    ctx.switchToHttp().getRequest<WorkerRequest>().internalBody,
);

function bad(message: string): BadRequestException {
  return new BadRequestException({
    error: 'WORKER_BAD_BODY',
    code: 'WORKER_BAD_BODY',
    message,
  });
}

function fields(
  b: unknown,
  required: readonly string[],
): Record<string, unknown> {
  if (!b || typeof b !== 'object' || Array.isArray(b)) {
    throw bad('Ожидается JSON-объект');
  }
  const o = b as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (!required.includes(k)) throw bad(`Лишнее поле «${k}»`);
  }
  for (const k of required) {
    if (o[k] === undefined) throw bad(`Нет поля «${k}»`);
  }
  return o;
}

function leaseOf(o: Record<string, unknown>): { jobId: string; token: string } {
  if (typeof o.jobId !== 'string' || !JOB_ID_RE.test(o.jobId)) {
    throw bad('jobId');
  }
  if (typeof o.leaseToken !== 'string' || !LEASE_TOKEN_RE.test(o.leaseToken)) {
    throw bad('leaseToken');
  }
  return { jobId: o.jobId, token: o.leaseToken };
}

function dim(v: unknown): number | null {
  if (v === null) return null;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 20_000) {
    throw bad('width/height');
  }
  return v;
}

@Controller('internal/worker/v1/jobs')
@PublicRoute(
  'канал браузерного воркера Ш3: HMAC с меткой времени и id (SITES_WORKER_HMAC_SECRET)',
)
@UseGuards(WorkerHmacGuard)
export class InternalWorkerController {
  constructor(
    private readonly jobs: BrowserJobsService,
    private readonly svc: InternalWorkerService,
  ) {}

  @Post('claim')
  @HttpCode(200)
  async claim(@Body() b: unknown) {
    const o = fields(b, ['workerId', 'kinds', 'max']);
    if (typeof o.workerId !== 'string' || !WORKER_ID_RE.test(o.workerId)) {
      throw bad('workerId');
    }
    if (
      !Array.isArray(o.kinds) ||
      o.kinds.length === 0 ||
      o.kinds.length > 8 ||
      !o.kinds.every(isBrowserJobKind)
    ) {
      throw bad('kinds');
    }
    if (
      typeof o.max !== 'number' ||
      !Number.isInteger(o.max) ||
      o.max < 1 ||
      o.max > WORKER_LIMITS.claimMax
    ) {
      throw bad('max');
    }
    const jobs = await this.jobs.claim(
      o.workerId,
      o.kinds as BrowserJobKind[],
      o.max,
    );
    return { enabled: this.jobs.enabled(), jobs };
  }

  @Post('heartbeat')
  @HttpCode(200)
  heartbeat(@Body() b: unknown) {
    const l = leaseOf(fields(b, ['jobId', 'leaseToken']));
    return this.jobs.heartbeat(l.jobId, l.token);
  }

  @Post('complete')
  @HttpCode(200)
  complete(@Body() b: unknown) {
    const o = fields(b, ['jobId', 'leaseToken', 'result']);
    const l = leaseOf(o);
    return this.jobs.complete(l.jobId, l.token, o.result);
  }

  @Post('fail')
  @HttpCode(200)
  fail(@Body() b: unknown) {
    const o = fields(b, ['jobId', 'leaseToken', 'code']);
    const l = leaseOf(o);
    if (!isWorkerErrorCode(o.code)) throw bad('code');
    return this.jobs.fail(l.jobId, l.token, o.code);
  }

  @Post('credentials')
  @HttpCode(200)
  credentials(@Body() b: unknown) {
    const l = leaseOf(fields(b, ['jobId', 'leaseToken']));
    return this.svc.credentials(l.jobId, l.token);
  }

  @Post('artifact')
  @HttpCode(200)
  artifact(@Body() b: unknown) {
    const o = fields(b, [
      'jobId',
      'leaseToken',
      'idx',
      'contentType',
      'width',
      'height',
      'data',
    ]);
    const l = leaseOf(o);
    if (typeof o.idx !== 'number' || typeof o.contentType !== 'string') {
      throw bad('idx/contentType');
    }
    if (typeof o.data !== 'string') throw bad('data');
    return this.jobs.putArtifact(l.jobId, l.token, {
      idx: o.idx,
      contentType: o.contentType,
      data: o.data,
      width: dim(o.width),
      height: dim(o.height),
    });
  }
}
