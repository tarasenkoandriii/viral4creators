/**
 * Гвард канала браузерного воркера (Э-С Ш3): та же подпись, что у каналов
 * обучалки и Flow-QA (`shared/sites-internal-signature.ts`: HMAC метода,
 * пути, тела, метки времени и id; окно ±5 мин; id — один раз), но:
 *  - СВОЙ секрет `SITES_WORKER_HMAC_SECRET` и свой вызывающий
 *    `browser-worker` (П-С3 «отдельный секрет на направление»): воркер
 *    живёт на отдельном VPS рядом с чужим JS — утечка его секрета не
 *    должна открывать ни канал генератора, ни карту QA, ни админку;
 *  - секрет, совпавший с секретом любого другого направления или с другим
 *    секретом sites-backend (кроны, KEK учёток Ш2 — `workerSecretCollision`,
 *    аудит Ш3), — маршруты закрыты (503), как без секрета;
 *  - свой потолок тела по маршруту (claim/heartbeat — 8 КБ, результат —
 *    384 КБ, артефакт — 2,2 МБ);
 *  - журнал id — та же таблица `site_internal_requests` (вызывающий —
 *    часть строки), но свой класс: модуль `internal-sites` — лист графа.
 *
 * Тело приходит СТРОКОЙ (`app.setup.ts`, `/internal/worker`): подпись — по
 * байтам запроса, JSON разбирается только после проверки (`req.internalBody`).
 */
import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  HttpException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  WORKER_SECRET_ENV,
  workerSecretCollision,
} from '../../config/browser-worker-env';
import {
  isUsableSitesSecret,
  verifySitesRequest,
} from '../../shared/sites-internal-signature';
import {
  WORKER_CALLER,
  WORKER_LIMITS,
  WORKER_ROUTES,
} from '../browser-jobs/protocol';
import { WorkerRequestLedger } from './worker-request-ledger';

export type WorkerRequest = Request & { internalBody?: unknown };

export function workerBodyLimit(path: string): number {
  if (path === WORKER_ROUTES.complete) return WORKER_LIMITS.completeBodyBytes;
  if (path === WORKER_ROUTES.artifact) return WORKER_LIMITS.artifactBodyBytes;
  return WORKER_LIMITS.smallBodyBytes;
}

function err(
  Ctor: new (body: Record<string, unknown>) => HttpException,
  code: string,
  message: string,
): HttpException {
  return new Ctor({ error: code, code, message });
}

@Injectable()
export class WorkerHmacGuard implements CanActivate {
  /** Тесты подменяют env и часы. */
  env: NodeJS.ProcessEnv = process.env;
  now: () => Date = () => new Date();

  constructor(private readonly ledger: WorkerRequestLedger) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<WorkerRequest>();
    const secret = this.env[WORKER_SECRET_ENV]?.trim();
    if (!isUsableSitesSecret(secret)) {
      throw err(
        ServiceUnavailableException,
        'INTERNAL_NOT_CONFIGURED',
        `${WORKER_SECRET_ENV} не задан (≥ 32 символа) — канал браузерного воркера закрыт`,
      );
    }
    const other = workerSecretCollision(this.env, secret);
    if (other) {
      throw err(
        ServiceUnavailableException,
        'INTERNAL_NOT_CONFIGURED',
        `${WORKER_SECRET_ENV} совпадает с ${other} — канал браузерного воркера закрыт`,
      );
    }
    const raw = typeof req.body === 'string' ? req.body : '';
    const path = (req.originalUrl ?? req.url ?? '').split('?')[0];
    if (Buffer.byteLength(raw, 'utf8') > workerBodyLimit(path)) {
      throw err(BadRequestException, 'WORKER_BAD_BODY', 'Тело слишком большое');
    }
    const now = this.now();
    const check = verifySitesRequest(secret, {
      method: req.method,
      path,
      body: raw,
      headers: req.headers,
      nowSeconds: Math.floor(now.getTime() / 1000),
      expectedCaller: WORKER_CALLER,
    });
    if (!check.ok) {
      throw err(
        UnauthorizedException,
        `INTERNAL_SIGNATURE_${check.reason.toUpperCase()}`,
        'Подпись запроса воркера не принята',
      );
    }
    if (!(await this.ledger.claim(check.requestId, path, now))) {
      throw err(
        UnauthorizedException,
        'INTERNAL_REPLAY',
        'Этот подписанный запрос уже выполнялся',
      );
    }
    try {
      req.internalBody = raw ? (JSON.parse(raw) as unknown) : undefined;
    } catch {
      throw err(BadRequestException, 'WORKER_BAD_BODY', 'Ожидается JSON');
    }
    return true;
  }
}
