/**
 * Очередь заданий браузерного воркера (Э-С Ш3; QA-ТЗ §4.3 «Postgres,
 * lease-паттерн проекта»): `lockedUntil` + `attempts` + условный
 * `updateMany`, без `SKIP LOCKED` (пулер Supabase в transaction mode
 * блокировку на длинный прогон не удержит).
 *
 * Жизнь задания:
 *   queued ──claim──▶ running ──complete──▶ done
 *     ▲                 │ fail (повторяемый код, попытки есть) / аренда истекла
 *     └─────────────────┘
 *                       └─fail (иначе) / отмена / хост отозван──▶ failed | cancelled
 *
 *  - аренда — случайный токен (у воркера) и его SHA-256 (в базе); каждое
 *    действие воркера сверяет id, статус `running` и хеш — чужой или
 *    устаревший токен (задание уже переотдано) получает 409 и ничего не
 *    меняет;
 *  - heartbeat продлевает аренду; пропавший воркер теряет задание через
 *    `leaseMs` — его подбирает следующий claim (повтор, если попытки есть);
 *  - повтор решает СЕРВЕР по коду ошибки из закрытого списка;
 *  - перед выдачей хост перепроверяется (`evaluateHostAccess` по
 *    назначению источника): отзыв подтверждения, пока задание ждало, —
 *    отказ `host_not_verified`, воркер его не получает;
 *  - справедливость: за один claim — не больше одного задания кабинета и
 *    не больше `RUNNING_PER_ACCOUNT` идущих на кабинет;
 *  - выключатель `BROWSER_WORKER_ENABLED`: выключен — продукты не ставят,
 *    claim пуст, heartbeat идущих отвечает «отменить».
 *
 * Межкабинетные запросы (claim, аренда, ретенция) — только системным
 * клиентом с причиной; продукты ставят и читают задания своего кабинета.
 */
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import {
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  browserWorkerEnabled,
  workerSealPublicKey,
} from '../../config/browser-worker-env';
import { SitesDb } from '../../prisma/sites-db.service';
import { evaluateHostAccess } from '../site-core/ownership/host-access';
import { BrowserArtifactStorage, artifactPathname } from './artifact-storage';
import {
  ARTIFACT_LINK_TTL_MS,
  BrowserJobOrigin,
  ORIGIN_RULES,
  RUNNING_PER_ACCOUNT,
  isBrowserJobOrigin,
  lockHostName,
  retryDelayMs,
} from './browser-job-rules';
import { BrowserJobHandlers, type HandlerJob } from './job-handlers';
import {
  ARTIFACT_TYPES,
  BrowserJobKind,
  BrowserJobParams,
  ClaimedJob,
  JOB_WALL_MS,
  ProtocolError,
  RETRYABLE_ERRORS,
  WORKER_LIMITS,
  WorkerErrorCode,
  isBrowserJobKind,
  parseJobParams,
  parseJobResult,
} from './protocol';

export interface EnqueueInput {
  siteId: string;
  hostId: string;
  origin: BrowserJobOrigin;
  params: BrowserJobParams;
  refId?: string | null;
  testAccountId?: string | null;
  idempotencyKey?: string | null;
  requestedBy: string;
}

export interface BrowserJobView {
  id: string;
  kind: string;
  origin: string;
  refId: string | null;
  status: string;
  attempts: number;
  errorCode: string | null;
  result: unknown;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  expiresAt: Date;
}

export interface ArtifactLink {
  idx: number;
  url: string;
  contentType: string;
  bytes: number;
  width: number | null;
  height: number | null;
  linkExpiresAt: Date;
}

type JobRow = Prisma.SiteBrowserJobGetPayload<object>;

export function jobError(
  status: HttpStatus,
  code: string,
  message: string,
): HttpException {
  return new HttpException({ error: code, code, message }, status);
}

export const leaseLost = () =>
  new ConflictException({
    error: 'WORKER_LEASE_LOST',
    code: 'WORKER_LEASE_LOST',
    message:
      'Аренда задания недействительна (задание переотдано, завершено или отменено)',
  });

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function sameHash(a: string | null, b: string): boolean {
  if (!a || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

const JPEG = Buffer.from([0xff, 0xd8, 0xff]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

@Injectable()
export class BrowserJobsService {
  private readonly logger = new Logger(BrowserJobsService.name);
  env: NodeJS.ProcessEnv = process.env;
  now: () => Date = () => new Date();

  constructor(
    private readonly sitesDb: SitesDb,
    private readonly storage: BrowserArtifactStorage,
    private readonly handlers: BrowserJobHandlers,
  ) {}

  enabled(): boolean {
    return browserWorkerEnabled(this.env);
  }

  /** Учётки воркеру выдаются только при заданном открытом ключе конверта. */
  credentialsEnabled(): boolean {
    return this.enabled() && workerSealPublicKey(this.env) !== null;
  }

  private sys(reason: string) {
    return this.sitesDb.system(`браузерный воркер Ш3: ${reason}`);
  }

  // ── продукты ───────────────────────────────────────────────────────────

  assertEnabled(): void {
    if (!this.enabled()) {
      throw jobError(
        HttpStatus.CONFLICT,
        'BROWSER_WORKER_DISABLED',
        'Браузерный воркер не подключён — задание не поставлено',
      );
    }
  }

  /**
   * Поставить задание. Хост — этого сайта и подтверждён для назначения
   * источника (L1, без льготы); замок задания — ровно этот хост.
   */
  async enqueue(
    accountId: string,
    input: EnqueueInput,
  ): Promise<BrowserJobView> {
    this.assertEnabled();
    const rule = ORIGIN_RULES[input.origin];
    const now = this.now();
    const db = this.sitesDb.forAccount(accountId);
    const host = await db.siteHost.findFirst({
      where: { id: input.hostId, siteId: input.siteId },
    });
    if (!host || !evaluateHostAccess(host, rule.purpose, now).ok) {
      throw jobError(
        HttpStatus.CONFLICT,
        'BROWSER_JOB_HOST',
        'Хост не подтверждён для этого задания',
      );
    }
    const params = parseJobParams(rule.kind, input.params);
    const lock = lockHostName(host);
    const hosts = (params as { allowedHosts: string[] }).allowedHosts;
    if (hosts.length !== 1 || hosts[0] !== lock) {
      throw new Error('browser-jobs: замок задания — только хост задания');
    }
    if (input.idempotencyKey) {
      const same = await db.siteBrowserJob.findFirst({
        where: { idempotencyKey: input.idempotencyKey },
      });
      if (same) return this.toView(same);
    }
    const [active, daily] = await Promise.all([
      db.siteBrowserJob.count({
        where: {
          siteId: input.siteId,
          origin: input.origin,
          status: { in: ['queued', 'running'] },
        },
      }),
      db.siteBrowserJob.count({
        where: {
          siteId: input.siteId,
          origin: input.origin,
          createdAt: { gt: new Date(now.getTime() - 24 * 3600_000) },
        },
      }),
    ]);
    if (active >= rule.activePerSite) {
      throw jobError(
        HttpStatus.TOO_MANY_REQUESTS,
        'BROWSER_JOB_BUSY',
        'Предыдущие задания этого вида ещё выполняются — попробуйте позже',
      );
    }
    if (daily >= rule.dailyPerSite) {
      throw jobError(
        HttpStatus.TOO_MANY_REQUESTS,
        'BROWSER_JOB_DAILY_LIMIT',
        'Суточный лимит заданий этого вида для сайта исчерпан',
      );
    }
    try {
      const row = await db.siteBrowserJob.create({
        data: {
          accountId,
          siteId: input.siteId,
          hostId: input.hostId,
          kind: rule.kind,
          origin: input.origin,
          refId: input.refId ?? null,
          params: params as unknown as Prisma.InputJsonValue,
          testAccountId: input.testAccountId ?? null,
          idempotencyKey: input.idempotencyKey ?? null,
          priority: rule.priority,
          maxAttempts: rule.maxAttempts,
          requestedBy: input.requestedBy,
          availableAt: now,
          expiresAt: new Date(now.getTime() + rule.ttlMs),
        },
      });
      return this.toView(row);
    } catch (e) {
      if (
        input.idempotencyKey &&
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        const same = await db.siteBrowserJob.findFirst({
          where: { idempotencyKey: input.idempotencyKey },
        });
        if (same) return this.toView(same);
      }
      throw e;
    }
  }

  async view(
    accountId: string,
    jobId: string,
    where: { siteId?: string; origin?: BrowserJobOrigin } = {},
  ): Promise<BrowserJobView | null> {
    const row = await this.sitesDb
      .forAccount(accountId)
      .siteBrowserJob.findFirst({ where: { id: jobId, ...where } });
    return row ? this.toView(row) : null;
  }

  async latest(
    accountId: string,
    where: { siteId: string; origin: BrowserJobOrigin; refId?: string },
  ): Promise<BrowserJobView | null> {
    const row = await this.sitesDb
      .forAccount(accountId)
      .siteBrowserJob.findFirst({ where, orderBy: { createdAt: 'desc' } });
    return row ? this.toView(row) : null;
  }

  /** Отмена: ожидающее — сразу, идущее — на ближайшем heartbeat воркера. */
  async cancel(accountId: string, jobId: string): Promise<void> {
    const db = this.sitesDb.forAccount(accountId);
    const now = this.now();
    const row = await db.siteBrowserJob.findFirst({ where: { id: jobId } });
    if (!row) return;
    const { count } = await db.siteBrowserJob.updateMany({
      where: { id: jobId, status: 'queued' },
      data: { status: 'cancelled', errorCode: 'cancelled', finishedAt: now },
    });
    if (count === 1) {
      await this.notifyFailed(row, 'cancelled');
      return;
    }
    await db.siteBrowserJob.updateMany({
      where: { id: jobId, status: 'running' },
      data: { cancelRequestedAt: now },
    });
  }

  /** Подписанные ссылки на артефакты задания (≤ 15 мин). */
  async artifactLinks(
    accountId: string,
    jobId: string,
  ): Promise<ArtifactLink[]> {
    const now = this.now();
    const rows = await this.sitesDb
      .forAccount(accountId)
      .siteBrowserArtifact.findMany({
        where: { jobId, expiresAt: { gt: now } },
        orderBy: { idx: 'asc' },
      });
    const out: ArtifactLink[] = [];
    for (const a of rows) {
      const until = new Date(
        Math.min(now.getTime() + ARTIFACT_LINK_TTL_MS, a.expiresAt.getTime()),
      );
      out.push({
        idx: a.idx,
        url: await this.storage.signedUrl(a.pathname, until),
        contentType: a.contentType,
        bytes: a.bytes,
        width: a.width,
        height: a.height,
        linkExpiresAt: until,
      });
    }
    return out;
  }

  toView(row: JobRow): BrowserJobView {
    return {
      id: row.id,
      kind: row.kind,
      origin: row.origin,
      refId: row.refId,
      status: row.status,
      attempts: row.attempts,
      errorCode: row.errorCode,
      result: row.status === 'done' ? row.result : null,
      createdAt: row.createdAt,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      expiresAt: row.expiresAt,
    };
  }

  // ── воркер ─────────────────────────────────────────────────────────────

  private handlerJob(row: JobRow): HandlerJob {
    return {
      id: row.id,
      accountId: row.accountId,
      siteId: row.siteId,
      hostId: row.hostId,
      kind: row.kind as BrowserJobKind,
      origin: row.origin as BrowserJobOrigin,
      refId: row.refId,
      params: row.params as unknown as BrowserJobParams,
      testAccountId: row.testAccountId,
    };
  }

  private async notifyFailed(row: JobRow, code: string): Promise<void> {
    if (!isBrowserJobOrigin(row.origin)) return;
    const h = this.handlers.get(row.origin);
    if (!h?.onFailed) return;
    try {
      await h.onFailed(this.handlerJob(row), code);
    } catch (e) {
      this.logger.warn(
        `обработчик отказа ${row.origin}: ${e instanceof Error ? e.name : 'error'}`,
      );
    }
  }

  /** Окончательный отказ задания (без повтора) + уведомление продукта. */
  private async finalFail(
    row: JobRow,
    code: WorkerErrorCode,
    where: Prisma.SiteBrowserJobWhereInput,
    now: Date,
  ): Promise<boolean> {
    const { count } = await this.sys(
      'окончательный отказ задания',
    ).siteBrowserJob.updateMany({
      where: { id: row.id, ...where },
      data: {
        status: code === 'cancelled' ? 'cancelled' : 'failed',
        errorCode: code,
        finishedAt: now,
        leaseOwner: null,
        leaseTokenHash: null,
        leaseUntil: null,
      },
    });
    if (count === 1) await this.notifyFailed(row, code);
    return count === 1;
  }

  /** Истёкшие аренды: повтор, если попытки есть, иначе отказ. */
  private async reapExpired(now: Date): Promise<void> {
    const db = this.sys('истёкшие аренды');
    const expired = await db.siteBrowserJob.findMany({
      where: { status: 'running', leaseUntil: { lt: now } },
      take: 20,
    });
    for (const row of expired) {
      const cond = {
        status: 'running',
        leaseTokenHash: row.leaseTokenHash,
        leaseUntil: { lt: now },
      };
      if (row.attempts < row.maxAttempts && !row.cancelRequestedAt) {
        await db.siteBrowserJob.updateMany({
          where: { id: row.id, ...cond },
          data: {
            status: 'queued',
            leaseOwner: null,
            leaseTokenHash: null,
            leaseUntil: null,
            errorCode: 'job_timeout',
            availableAt: new Date(now.getTime() + retryDelayMs(row.attempts)),
          },
        });
      } else {
        await this.finalFail(
          row,
          row.cancelRequestedAt ? 'cancelled' : 'job_timeout',
          cond,
          now,
        );
      }
    }
  }

  async claim(
    workerId: string,
    kinds: readonly BrowserJobKind[],
    max: number,
  ): Promise<ClaimedJob[]> {
    if (!this.enabled()) return [];
    const now = this.now();
    await this.reapExpired(now);
    const db = this.sys('выдача заданий воркеру (все кабинеты)');
    // Без открытого ключа конверта учётку воркер не получит — обход за
    // логином не выдаётся вовсе (иначе он упал бы на входе).
    const allowedKinds = kinds.filter(
      (k) =>
        isBrowserJobKind(k) &&
        (k !== 'admin-crawl' || this.credentialsEnabled()),
    );
    if (!allowedKinds.length || max < 1) return [];
    // Справедливость (аудит Ш3): кабинеты, у которых уже
    // RUNNING_PER_ACCOUNT идущих, отсекаются ДО окна кандидатов. Раньше
    // окно (50 строк) брали без этого, и 50+ ожидающих одного занятого
    // кабинета закрывали его целиком — задания остальных кабинетов не
    // выдавались, пока очередь «соседа» не рассосётся. Идущих мало
    // (воркеры × конкурентность) — сводка по всем дешёвая.
    const running = await db.siteBrowserJob.groupBy({
      by: ['accountId'],
      where: { status: 'running' },
      _count: { _all: true },
    });
    const busy = new Map(running.map((r) => [r.accountId, r._count._all]));
    const full = [...busy]
      .filter(([, n]) => n >= RUNNING_PER_ACCOUNT)
      .map(([accountId]) => accountId);
    const candidates = await db.siteBrowserJob.findMany({
      where: {
        status: 'queued',
        availableAt: { lte: now },
        cancelRequestedAt: null,
        kind: { in: allowedKinds },
        ...(full.length ? { accountId: { notIn: full } } : {}),
      },
      orderBy: [{ priority: 'desc' }, { availableAt: 'asc' }],
      take: 50,
    });
    if (!candidates.length) return [];
    const taken = new Set<string>();
    const out: ClaimedJob[] = [];
    for (const row of candidates) {
      if (out.length >= Math.min(max, WORKER_LIMITS.claimMax)) break;
      if (taken.has(row.accountId)) continue;
      if ((busy.get(row.accountId) ?? 0) >= RUNNING_PER_ACCOUNT) continue;
      if (!isBrowserJobOrigin(row.origin) || !isBrowserJobKind(row.kind))
        continue;
      // Хост перепроверяется перед КАЖДОЙ выдачей: подтверждение могли
      // отозвать, пока задание ждало.
      const host = await db.siteHost.findFirst({
        where: { id: row.hostId, accountId: row.accountId },
      });
      const purpose = ORIGIN_RULES[row.origin].purpose;
      if (!host || !evaluateHostAccess(host, purpose, now).ok) {
        await this.finalFail(
          row,
          'host_not_verified',
          { status: 'queued' },
          now,
        );
        continue;
      }
      let params: BrowserJobParams;
      try {
        params = parseJobParams(row.kind, row.params);
      } catch {
        await this.finalFail(row, 'bad_params', { status: 'queued' }, now);
        continue;
      }
      const token = randomBytes(32).toString('base64url');
      const leaseUntil = new Date(now.getTime() + WORKER_LIMITS.leaseMs);
      const { count } = await db.siteBrowserJob.updateMany({
        where: { id: row.id, status: 'queued', attempts: row.attempts },
        data: {
          status: 'running',
          attempts: { increment: 1 },
          leaseOwner: workerId,
          leaseTokenHash: hashToken(token),
          leaseUntil,
          heartbeatAt: now,
          startedAt: now,
          errorCode: null,
        },
      });
      if (count !== 1) continue;
      taken.add(row.accountId);
      busy.set(row.accountId, (busy.get(row.accountId) ?? 0) + 1);
      out.push({
        id: row.id,
        kind: row.kind,
        attempt: row.attempts + 1,
        leaseToken: token,
        leaseUntil: leaseUntil.toISOString(),
        wallMs: JOB_WALL_MS[row.kind],
        params,
        needsCredentials: row.kind === 'admin-crawl',
      });
      const h = this.handlers.get(row.origin);
      if (h?.onStarted) {
        await h
          .onStarted(this.handlerJob(row))
          .catch((e: unknown) =>
            this.logger.warn(
              `обработчик старта ${row.origin}: ${e instanceof Error ? e.name : 'error'}`,
            ),
          );
      }
    }
    return out;
  }

  /** Задание под действующей арендой этого токена (иначе 409). */
  async leased(jobId: string, token: string): Promise<JobRow> {
    const row = await this.sys('проверка аренды').siteBrowserJob.findFirst({
      where: { id: jobId },
    });
    if (
      !row ||
      row.status !== 'running' ||
      !sameHash(row.leaseTokenHash, hashToken(token))
    ) {
      throw leaseLost();
    }
    return row;
  }

  async heartbeat(
    jobId: string,
    token: string,
  ): Promise<{ ok: true; cancel: boolean; leaseUntil: string }> {
    const now = this.now();
    const row = await this.leased(jobId, token);
    const leaseUntil = new Date(now.getTime() + WORKER_LIMITS.leaseMs);
    const { count } = await this.sys(
      'продление аренды',
    ).siteBrowserJob.updateMany({
      where: {
        id: jobId,
        status: 'running',
        leaseTokenHash: row.leaseTokenHash,
      },
      data: { leaseUntil, heartbeatAt: now },
    });
    if (count !== 1) throw leaseLost();
    return {
      ok: true,
      // Выключатель — kill-switch: идущие задания гасятся тоже.
      cancel: !!row.cancelRequestedAt || !this.enabled(),
      leaseUntil: leaseUntil.toISOString(),
    };
  }

  async fail(
    jobId: string,
    token: string,
    code: WorkerErrorCode,
  ): Promise<{ ok: true; retry: boolean }> {
    const now = this.now();
    const row = await this.leased(jobId, token);
    const cond = { status: 'running', leaseTokenHash: row.leaseTokenHash };
    if (
      RETRYABLE_ERRORS.has(code) &&
      row.attempts < row.maxAttempts &&
      !row.cancelRequestedAt &&
      this.enabled()
    ) {
      const { count } = await this.sys(
        'повтор задания',
      ).siteBrowserJob.updateMany({
        where: { id: jobId, ...cond },
        data: {
          status: 'queued',
          errorCode: code,
          leaseOwner: null,
          leaseTokenHash: null,
          leaseUntil: null,
          availableAt: new Date(now.getTime() + retryDelayMs(row.attempts)),
        },
      });
      if (count !== 1) throw leaseLost();
      return { ok: true, retry: true };
    }
    const final: WorkerErrorCode = row.cancelRequestedAt ? 'cancelled' : code;
    if (!(await this.finalFail(row, final, cond, now))) throw leaseLost();
    return { ok: true, retry: false };
  }

  /**
   * Сдача результата: строгий разбор по виду и параметрам, артефакты,
   * на которые ссылается результат, — загружены. Переход `running → done`
   * — условным UPDATE (двойная сдача не проходит), затем обработчик
   * продукта; его сбой — `failed: internal` (без повтора: результат уже
   * принят, повтор браузера ничего не исправит).
   */
  async complete(
    jobId: string,
    token: string,
    raw: unknown,
  ): Promise<{ ok: true }> {
    const now = this.now();
    const row = await this.leased(jobId, token);
    if (!isBrowserJobKind(row.kind) || !isBrowserJobOrigin(row.origin)) {
      throw leaseLost();
    }
    const params = row.params as unknown as BrowserJobParams;
    let result;
    try {
      result = parseJobResult(row.kind, params, raw);
    } catch (e) {
      throw jobError(
        HttpStatus.BAD_REQUEST,
        'WORKER_BAD_RESULT',
        `Результат не принят: ${e instanceof ProtocolError ? e.field : 'формат'}`,
      );
    }
    const refs = artifactRefs(result);
    if (refs.length) {
      const have = await this.sys(
        'артефакты результата',
      ).siteBrowserArtifact.findMany({
        where: { jobId, idx: { in: refs } },
        select: { idx: true },
      });
      if (have.length !== new Set(refs).size) {
        throw jobError(
          HttpStatus.BAD_REQUEST,
          'WORKER_BAD_RESULT',
          'Результат ссылается на незагруженный артефакт',
        );
      }
    }
    const json = JSON.stringify(result);
    const bytes = Buffer.byteLength(json, 'utf8');
    if (bytes > WORKER_LIMITS.resultBytes) {
      throw jobError(
        HttpStatus.BAD_REQUEST,
        'WORKER_BAD_RESULT',
        'Результат слишком большой',
      );
    }
    const db = this.sys('сдача результата');
    const { count } = await db.siteBrowserJob.updateMany({
      where: {
        id: jobId,
        status: 'running',
        leaseTokenHash: row.leaseTokenHash,
      },
      data: {
        status: 'done',
        finishedAt: now,
        leaseOwner: null,
        leaseTokenHash: null,
        leaseUntil: null,
        errorCode: null,
        resultBytes: bytes,
        result: { pending: true },
      },
    });
    if (count !== 1) throw leaseLost();
    const h = this.handlers.get(row.origin);
    let stored: unknown = result;
    try {
      if (h?.onDone)
        stored = (await h.onDone(this.handlerJob(row), result)) ?? null;
    } catch (e) {
      this.logger.warn(
        `обработчик результата ${row.origin}: ${e instanceof Error ? e.name : 'error'}`,
      );
      await db.siteBrowserJob.updateMany({
        where: { id: jobId, status: 'done' },
        data: {
          status: 'failed',
          errorCode: 'internal',
          result: Prisma.DbNull,
        },
      });
      await this.notifyFailed(row, 'internal');
      return { ok: true };
    }
    await db.siteBrowserJob.updateMany({
      where: { id: jobId, status: 'done' },
      data: {
        result:
          stored === null || stored === undefined
            ? Prisma.DbNull
            : (stored as Prisma.InputJsonValue),
      },
    });
    return { ok: true };
  }

  /**
   * Учётка нужна воркеру (admin-crawl): один раз на попытку. Возвращает
   * контекст для аренды Ш2 (её делает канал воркера `internal-worker`).
   */
  async markCredentialsIssued(
    jobId: string,
    token: string,
  ): Promise<{
    accountId: string;
    hostId: string;
    testAccountId: string;
    attempt: number;
  }> {
    const row = await this.leased(jobId, token);
    if (row.kind !== 'admin-crawl' || !row.testAccountId) throw leaseLost();
    const { count } = await this.sys(
      'выдача учётки на попытку',
    ).siteBrowserJob.updateMany({
      where: {
        id: jobId,
        status: 'running',
        leaseTokenHash: row.leaseTokenHash,
        OR: [
          { credentialsAttempt: null },
          { credentialsAttempt: { lt: row.attempts } },
        ],
      },
      data: { credentialsAttempt: row.attempts },
    });
    if (count !== 1) {
      throw jobError(
        HttpStatus.CONFLICT,
        'WORKER_CREDENTIALS_USED',
        'Учётка на эту попытку уже выдана',
      );
    }
    return {
      accountId: row.accountId,
      hostId: row.hostId,
      testAccountId: row.testAccountId,
      attempt: row.attempts,
    };
  }

  /** Загрузка артефакта (скриншот/кадр) под арендой задания. */
  async putArtifact(
    jobId: string,
    token: string,
    a: {
      idx: number;
      contentType: string;
      data: string;
      width: number | null;
      height: number | null;
    },
  ): Promise<{ ok: true; idx: number; bytes: number }> {
    const row = await this.leased(jobId, token);
    if (
      !Number.isInteger(a.idx) ||
      a.idx < 0 ||
      a.idx >= WORKER_LIMITS.artifactsPerJob ||
      !(ARTIFACT_TYPES as readonly string[]).includes(a.contentType) ||
      typeof a.data !== 'string' ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(a.data)
    ) {
      throw jobError(
        HttpStatus.BAD_REQUEST,
        'WORKER_BAD_BODY',
        'Артефакт не принят',
      );
    }
    const body = Buffer.from(a.data, 'base64');
    const magic = a.contentType === 'image/png' ? PNG : JPEG;
    if (
      body.length === 0 ||
      body.length > WORKER_LIMITS.artifactBytes ||
      !body.subarray(0, magic.length).equals(magic)
    ) {
      throw jobError(
        HttpStatus.BAD_REQUEST,
        'WORKER_BAD_BODY',
        'Артефакт не принят',
      );
    }
    const db = this.sys('артефакт задания');
    const prev = await db.siteBrowserArtifact.findFirst({
      where: { jobId, idx: a.idx },
    });
    const pathname = artifactPathname({
      accountId: row.accountId,
      jobId,
      idx: a.idx,
      contentType: a.contentType,
    });
    await this.storage.put(pathname, body, a.contentType);
    const data = {
      pathname,
      contentType: a.contentType,
      bytes: body.length,
      sha256: createHash('sha256').update(body).digest('hex'),
      width: a.width,
      height: a.height,
      expiresAt: row.expiresAt,
    };
    if (prev) {
      await db.siteBrowserArtifact.updateMany({ where: { id: prev.id }, data });
      await this.storage.remove(prev.pathname).catch(() => undefined);
    } else {
      await db.siteBrowserArtifact.create({
        data: { ...data, accountId: row.accountId, jobId, idx: a.idx },
      });
    }
    return { ok: true, idx: a.idx, bytes: body.length };
  }

  // ── ретенция ───────────────────────────────────────────────────────────

  /**
   * Сроки: артефакты — по `expiresAt` (Blob, затем строка), задания — по
   * `expiresAt` (ожидавшие — с уведомлением продукта `job_timeout`).
   * Идущие не трогаются: их держит аренда.
   */
  async runRetention(
    now = this.now(),
    /** Только тесты на общей базе (`common/cron-scope.ts`): свои кабинеты. */
    scope: { accountIds: string[] } | null = null,
  ): Promise<{
    artifactsPurged: number;
    jobsPurged: number;
    blobErrors: number;
  }> {
    const db = this.sys('ретенция очереди и артефактов');
    const acc = scope ? { accountId: { in: scope.accountIds } } : {};
    let artifactsPurged = 0;
    let blobErrors = 0;
    for (;;) {
      const batch = await db.siteBrowserArtifact.findMany({
        where: { expiresAt: { lte: now }, ...acc },
        take: 200,
        orderBy: { expiresAt: 'asc' },
      });
      if (!batch.length) break;
      for (const a of batch) {
        try {
          await this.storage.remove(a.pathname);
        } catch {
          blobErrors += 1;
        }
        await db.siteBrowserArtifact.deleteMany({ where: { id: a.id } });
        artifactsPurged += 1;
      }
      if (batch.length < 200) break;
    }
    const stale = await db.siteBrowserJob.findMany({
      where: { expiresAt: { lte: now }, status: 'queued', ...acc },
      take: 500,
    });
    for (const row of stale) {
      await this.finalFail(row, 'job_timeout', { status: 'queued' }, now);
    }
    // Артефакты заданий, которые уходят, — сначала из Blob.
    const leaving = await db.siteBrowserArtifact.findMany({
      where: {
        ...acc,
        job: { expiresAt: { lte: now }, status: { not: 'running' } },
      },
      take: 1000,
    });
    for (const a of leaving) {
      try {
        await this.storage.remove(a.pathname);
      } catch {
        blobErrors += 1;
      }
    }
    const { count } = await db.siteBrowserJob.deleteMany({
      where: { expiresAt: { lte: now }, status: { not: 'running' }, ...acc },
    });
    return { artifactsPurged, jobsPurged: count, blobErrors };
  }

  /** Сводка для чек-листа деплоя и TMA: включён ли воркер и что ждёт. */
  async health(): Promise<{
    enabled: boolean;
    credentials: boolean;
    queued: number;
    running: number;
    lastHeartbeatAt: Date | null;
  }> {
    const db = this.sys('сводка очереди');
    const [queued, running, last] = await Promise.all([
      db.siteBrowserJob.count({ where: { status: 'queued' } }),
      db.siteBrowserJob.count({ where: { status: 'running' } }),
      db.siteBrowserJob.findFirst({
        where: { heartbeatAt: { not: null } },
        orderBy: { heartbeatAt: 'desc' },
        select: { heartbeatAt: true },
      }),
    ]);
    return {
      enabled: this.enabled(),
      credentials: this.credentialsEnabled(),
      queued,
      running,
      lastHeartbeatAt: last?.heartbeatAt ?? null,
    };
  }
}

/** Номера артефактов, на которые ссылается результат. */
export function artifactRefs(result: unknown): number[] {
  const out: number[] = [];
  const r = result as {
    screenshot?: number | null;
    frames?: Array<{ artifact: number }>;
  };
  if (typeof r.screenshot === 'number') out.push(r.screenshot);
  if (Array.isArray(r.frames)) for (const f of r.frames) out.push(f.artifact);
  return out;
}
