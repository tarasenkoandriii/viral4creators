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
 *    claim пуст, heartbeat идущих отвечает «отменить»;
 *  - уборка (`reap`, крон `browser-jobs-reap` каждые 5 мин и ретенция —
 *    БЕЗ проверки выключателя, аудит Ш3 P2): истёкшая аренда — повтор или
 *    отказ (выключен — сразу отказ `worker_disabled`), ожидающее с
 *    запросом отмены — `cancelled`, «сданное» задание, чей обработчик
 *    продукта оборвался (`result: {pending:true}` дольше
 *    `DONE_PENDING_GRACE_MS`), — `failed: internal` с уведомлением
 *    продукта; затем сверка продуктов (`reconcile` обработчиков). Иначе
 *    задание и запись продукта висели бы `running` навсегда;
 *  - лимиты «прочитал — создал» (`activePerSite`/`dailyPerSite` при
 *    постановке, `RUNNING_PER_ACCOUNT` при выдаче) — под
 *    `pg_advisory_xact_lock` сайта/кабинета в короткой транзакции: две
 *    параллельные постановки или два воркера лимит не перешагнут.
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
import { registrableDomain } from '../site-core/hosts/host-normalize';
import { BrowserArtifactStorage, artifactPathname } from './artifact-storage';
import {
  ARTIFACT_LINK_TTL_MS,
  BrowserJobOrigin,
  OPEN_LIMITS,
  ORIGIN_RULES,
  RUNNING_PER_ACCOUNT,
  isBrowserJobOrigin,
  lockHostName,
  openAccountId,
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
  wellFormed,
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

/**
 * Код отказа, которым уборка закрывает идущее задание при ВЫКЛЮЧЕННОМ
 * воркере (аренда истекла, а heartbeat уже некому слать) — только сервер,
 * в протоколе воркера его нет.
 */
export const WORKER_DISABLED_CODE = 'worker_disabled';
type FinalCode = WorkerErrorCode | typeof WORKER_DISABLED_CODE;

/**
 * Сколько «сданное» задание может ждать обработчик продукта
 * (`result: {pending:true}`), прежде чем уборка сочтёт, что функция
 * оборвалась (больше потолка длительности функции Vercel).
 */
export const DONE_PENDING_GRACE_MS = 15 * 60_000;

/** Ограничение уборки и ретенции своими кабинетами (тесты на общей базе). */
export type JobScope = { accountIds: string[] } | null;

export interface ReapReport {
  requeued: number;
  failed: number;
  cancelledQueued: number;
  pendingFailed: number;
  reconciled: number;
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
    const purpose = rule.purpose;
    if (purpose === null) {
      throw new Error('browser-jobs: задание без хоста — только enqueueOpen');
    }
    const now = this.now();
    const db = this.sitesDb.forAccount(accountId);
    const host = await db.siteHost.findFirst({
      where: { id: input.hostId, siteId: input.siteId },
    });
    if (!host || !evaluateHostAccess(host, purpose, now).ok) {
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
    // Аудит Ш3 P3: «посчитал — создал» под замком сайта и источника —
    // параллельные постановки не перешагнут `activePerSite`/`dailyPerSite`.
    try {
      const row = await db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`browser-jobs:site:${input.siteId}:${input.origin}`}))`;
        const [active, daily] = await Promise.all([
          tx.siteBrowserJob.count({
            where: {
              siteId: input.siteId,
              origin: input.origin,
              status: { in: ['queued', 'running'] },
            },
          }),
          tx.siteBrowserJob.count({
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
        return tx.siteBrowserJob.create({
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

  /**
   * Ш3-хвост (3), режим B: задание БЕЗ хоста кабинета (решение владельца
   * «B ничего не блокирует»). Только источники с `purpose: null`; замок —
   * точные хосты из параметров (их выбирает канал генератора — хосты
   * черновика); лимиты — на человека (`subject`) и на хост (`refId` —
   * регистрируемый домен первого хоста замка) под `pg_advisory_xact_lock`. Прочие защиты воркера
   * (прокси, замок главного фрейма, стоп-лист, потолки трафика) — те же.
   */
  async enqueueOpen(input: {
    subject: string;
    origin: BrowserJobOrigin;
    params: BrowserJobParams;
    requestedBy: string;
  }): Promise<BrowserJobView> {
    this.assertEnabled();
    const rule = ORIGIN_RULES[input.origin];
    if (rule.purpose !== null) {
      throw new Error('browser-jobs: enqueueOpen — только задания без хоста');
    }
    const accountId = openAccountId(input.subject);
    const params = parseJobParams(rule.kind, input.params);
    // Лимит «на хост» — по РЕГИСТРИРУЕМОМУ домену (аудит захода 7): иначе
    // поддомены одного сайта (a.shop.com, b.shop.com…) обходили бы потолок.
    const first = (params as { allowedHosts: string[] }).allowedHosts[0];
    const bare = first.replace(/:\d+$/, '');
    const host = registrableDomain(bare) ?? bare;
    const now = this.now();
    const dayAgo = new Date(now.getTime() - 24 * 3600_000);
    const db = this.sys('задание без кабинета (режим B обучалки)');
    const row = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`browser-jobs:open:${accountId}`}))`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`browser-jobs:open-host:${host}`}))`;
      const mine = { accountId, origin: input.origin };
      const onHost = { refId: host, origin: input.origin };
      const active = { status: { in: ['queued', 'running'] } };
      const day = { createdAt: { gt: dayAgo } };
      const [a, d, ha, hd] = await Promise.all([
        tx.siteBrowserJob.count({ where: { ...mine, ...active } }),
        tx.siteBrowserJob.count({ where: { ...mine, ...day } }),
        tx.siteBrowserJob.count({ where: { ...onHost, ...active } }),
        tx.siteBrowserJob.count({ where: { ...onHost, ...day } }),
      ]);
      if (
        a >= OPEN_LIMITS.activePerSubject ||
        ha >= OPEN_LIMITS.activePerHost
      ) {
        throw jobError(
          HttpStatus.TOO_MANY_REQUESTS,
          'BROWSER_JOB_BUSY',
          'Предыдущие задания этого вида ещё выполняются — попробуйте позже',
        );
      }
      if (d >= OPEN_LIMITS.dailyPerSubject || hd >= OPEN_LIMITS.dailyPerHost) {
        throw jobError(
          HttpStatus.TOO_MANY_REQUESTS,
          'BROWSER_JOB_DAILY_LIMIT',
          'Суточный лимит заданий этого вида исчерпан',
        );
      }
      return tx.siteBrowserJob.create({
        data: {
          accountId,
          siteId: null,
          hostId: null,
          kind: rule.kind,
          origin: input.origin,
          refId: host,
          params: params as unknown as Prisma.InputJsonValue,
          priority: rule.priority,
          maxAttempts: rule.maxAttempts,
          requestedBy: input.requestedBy,
          availableAt: now,
          expiresAt: new Date(now.getTime() + rule.ttlMs),
        },
      });
    });
    return this.toView(row);
  }

  /**
   * Результат сданного задания больше не нужен продукту (рендер SPA:
   * HTML разобран обходом) — стереть, не дожидаясь срока строки.
   */
  async dropResult(
    accountId: string,
    jobId: string,
    where: { origin?: BrowserJobOrigin } = {},
  ): Promise<void> {
    await this.sitesDb.forAccount(accountId).siteBrowserJob.updateMany({
      where: {
        id: jobId,
        status: { in: ['done', 'failed', 'cancelled'] },
        ...where,
      },
      data: { result: Prisma.DbNull, resultBytes: null },
    });
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

  /**
   * Отменить, ТОЛЬКО если задание ещё ждёт (Ш3-хвост (3)): идущее не
   * трогается — генератор, не дождавшись воркера, выполняет раунд в функции
   * лишь тогда, когда воркер его гарантированно не получит.
   */
  async cancelIfQueued(accountId: string, jobId: string): Promise<boolean> {
    const db = this.sitesDb.forAccount(accountId);
    const row = await db.siteBrowserJob.findFirst({ where: { id: jobId } });
    if (!row) return false;
    const { count } = await db.siteBrowserJob.updateMany({
      where: { id: jobId, status: 'queued' },
      data: {
        status: 'cancelled',
        errorCode: 'cancelled',
        finishedAt: this.now(),
      },
    });
    if (count === 1) await this.notifyFailed(row, 'cancelled');
    return count === 1;
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
      // Задания без кабинета (`tutorial-explore-open`) обработчиков продукта
      // не имеют — пустые строки сюда не доходят до продуктов.
      siteId: row.siteId ?? '',
      hostId: row.hostId ?? '',
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
    code: FinalCode,
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

  /**
   * Истёкшие аренды: повтор, если попытки есть и воркер включён, иначе
   * отказ (`cancelled` — была отмена, `worker_disabled` — выключатель,
   * `job_timeout` — попытки кончились). Без проверки выключателя: при
   * выключенном воркере heartbeat некому слать, и без этого задание (и
   * запись продукта) висели бы `running` навсегда (аудит Ш3 P2).
   */
  private async reapLeases(
    now: Date,
    scope: JobScope = null,
  ): Promise<{ requeued: number; failed: number }> {
    const db = this.sys('истёкшие аренды');
    const acc = scope ? { accountId: { in: scope.accountIds } } : {};
    const enabled = this.enabled();
    let requeued = 0;
    let failed = 0;
    const seen = new Set<string>();
    for (let round = 0; round < 10; round++) {
      const expired = await db.siteBrowserJob.findMany({
        where: {
          status: 'running',
          leaseUntil: { lt: now },
          ...acc,
          ...(seen.size ? { id: { notIn: [...seen] } } : {}),
        },
        orderBy: { leaseUntil: 'asc' },
        take: 50,
      });
      if (!expired.length) break;
      for (const row of expired) {
        seen.add(row.id);
        const cond = {
          status: 'running',
          leaseTokenHash: row.leaseTokenHash,
          leaseUntil: { lt: now },
        };
        if (
          enabled &&
          row.attempts < row.maxAttempts &&
          !row.cancelRequestedAt
        ) {
          const { count } = await db.siteBrowserJob.updateMany({
            where: { id: row.id, ...cond, cancelRequestedAt: null },
            data: {
              status: 'queued',
              leaseOwner: null,
              leaseTokenHash: null,
              leaseUntil: null,
              errorCode: 'job_timeout',
              availableAt: new Date(now.getTime() + retryDelayMs(row.attempts)),
            },
          });
          requeued += count;
        } else {
          const code: FinalCode = row.cancelRequestedAt
            ? 'cancelled'
            : enabled
              ? 'job_timeout'
              : WORKER_DISABLED_CODE;
          if (await this.finalFail(row, code, cond, now)) failed += 1;
        }
      }
      if (expired.length < 50) break;
    }
    return { requeued, failed };
  }

  /**
   * Ожидающее с запросом отмены (`cancelRequestedAt`): отмену запросили,
   * пока оно шло, а повтор успел вернуть его в очередь, — claim его не
   * выдаёт, значит, закрываем как `cancelled` (иначе ждало бы срока).
   */
  private async reapCancelledQueued(
    now: Date,
    scope: JobScope = null,
  ): Promise<number> {
    const db = this.sys('ожидающие с запросом отмены');
    const rows = await db.siteBrowserJob.findMany({
      where: {
        status: 'queued',
        cancelRequestedAt: { not: null },
        ...(scope ? { accountId: { in: scope.accountIds } } : {}),
      },
      take: 200,
    });
    let n = 0;
    for (const row of rows) {
      if (
        await this.finalFail(
          row,
          'cancelled',
          { status: 'queued', cancelRequestedAt: { not: null } },
          now,
        )
      )
        n += 1;
    }
    return n;
  }

  /**
   * «Сдано», но обработчик продукта не дописал (`complete` ставит
   * `result: {pending:true}` до `onDone`): функция оборвалась между ними —
   * задание `done`, а продукт «идёт». Старше `DONE_PENDING_GRACE_MS` —
   * `failed: internal` и уведомление продукта (как сбой обработчика).
   */
  private async reapPendingDone(
    now: Date,
    scope: JobScope = null,
  ): Promise<number> {
    const db = this.sys('сданные задания без обработчика продукта');
    const pending = { path: ['pending'], equals: true };
    const rows = await db.siteBrowserJob.findMany({
      where: {
        status: 'done',
        result: pending,
        finishedAt: { lt: new Date(now.getTime() - DONE_PENDING_GRACE_MS) },
        ...(scope ? { accountId: { in: scope.accountIds } } : {}),
      },
      take: 100,
    });
    let n = 0;
    for (const row of rows) {
      const { count } = await db.siteBrowserJob.updateMany({
        where: { id: row.id, status: 'done', result: pending },
        data: {
          status: 'failed',
          errorCode: 'internal',
          result: Prisma.DbNull,
        },
      });
      if (count === 1) {
        n += 1;
        await this.notifyFailed(row, 'internal');
      }
    }
    return n;
  }

  /**
   * Уборка очереди (крон `browser-jobs-reap` и ретенция; без проверки
   * выключателя): аренды, ожидающие с отменой, оборванные обработчики,
   * затем сверка продуктов (`reconcile` обработчиков; сбой одного
   * продукта не мешает остальным).
   */
  async reap(now = this.now(), scope: JobScope = null): Promise<ReapReport> {
    const leases = await this.reapLeases(now, scope);
    const cancelledQueued = await this.reapCancelledQueued(now, scope);
    const pendingFailed = await this.reapPendingDone(now, scope);
    let reconciled = 0;
    if (!scope) {
      for (const [origin, h] of this.handlers.all()) {
        if (!h.reconcile) continue;
        try {
          reconciled += await h.reconcile(now);
        } catch (e) {
          this.logger.warn(
            `сверка продукта ${origin}: ${e instanceof Error ? e.name : 'error'}`,
          );
        }
      }
    }
    return { ...leases, cancelledQueued, pendingFailed, reconciled };
  }

  async claim(
    workerId: string,
    kinds: readonly BrowserJobKind[],
    max: number,
  ): Promise<ClaimedJob[]> {
    if (!this.enabled()) return [];
    const now = this.now();
    await this.reapLeases(now);
    await this.reapCancelledQueued(now);
    const db = this.sys('выдача заданий воркеру (все кабинеты)');
    // Без открытого ключа конверта учётку воркер не получит — обход за
    // логином не выдаётся вовсе (иначе он упал бы на входе).
    // Раунд обучалки — тоже: сессия черновика едет конвертом под этот ключ.
    const allowedKinds = kinds.filter(
      (k) =>
        isBrowserJobKind(k) &&
        ((k !== 'admin-crawl' && k !== 'tutorial-explore') ||
          this.credentialsEnabled()),
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
        // Аудит Ш3 P3: просроченное ждёт ретенции (`job_timeout`), а не
        // выдачи; с запросом отмены — не выдаётся (уборка закроет).
        expiresAt: { gt: now },
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
      // отозвать, пока задание ждало. Задание без хоста кабинета (режим B
      // обучалки) проверять нечем — его замок задан параметрами.
      const purpose = ORIGIN_RULES[row.origin].purpose;
      const host =
        purpose === null || !row.hostId
          ? null
          : await db.siteHost.findFirst({
              where: { id: row.hostId, accountId: row.accountId },
            });
      const hostOk =
        purpose === null
          ? row.hostId === null
          : !!host && evaluateHostAccess(host, purpose, now).ok;
      if (!hostOk) {
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
      // Аудит Ш3 P3: потолок идущих на кабинет — «посчитал — выдал» под
      // замком кабинета: два воркера разом не выдадут сверх
      // RUNNING_PER_ACCOUNT. Переход — условный (`queued` + та же попытка):
      // одно задание не выдаётся дважды.
      const taken1 = await db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`browser-jobs:account:${row.accountId}`}))`;
        const running = await tx.siteBrowserJob.count({
          where: { accountId: row.accountId, status: 'running' },
        });
        if (running >= RUNNING_PER_ACCOUNT) return { count: 0, running };
        const r = await tx.siteBrowserJob.updateMany({
          where: {
            id: row.id,
            status: 'queued',
            attempts: row.attempts,
            cancelRequestedAt: null,
            expiresAt: { gt: now },
          },
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
        return { count: r.count, running };
      });
      if (taken1.count !== 1) {
        busy.set(row.accountId, taken1.running);
        continue;
      }
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
        needsCredentials: needsCredentials(row),
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
        // Отмену могли запросить между чтением и повтором — тогда не в
        // очередь (там её claim не выдаст), а отказ `cancelled` ниже.
        where: { id: jobId, ...cond, cancelRequestedAt: null },
        data: {
          status: 'queued',
          errorCode: code,
          leaseOwner: null,
          leaseTokenHash: null,
          leaseUntil: null,
          availableAt: new Date(now.getTime() + retryDelayMs(row.attempts)),
        },
      });
      if (count === 1) return { ok: true, retry: true };
      const again = await this.leased(jobId, token);
      if (!again.cancelRequestedAt) throw leaseLost();
      if (!(await this.finalFail(again, 'cancelled', cond, now)))
        throw leaseLost();
      return { ok: true, retry: false };
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
      // Аудит P2-2: финальная запись — тоже здесь. Её сбой (например,
      // строка, которую не примет jsonb) не оставляет задание навсегда
      // «сдано, пишется» (`{pending:true}`), а закрывает `failed: internal`.
      await db.siteBrowserJob.updateMany({
        where: { id: jobId, status: 'done' },
        data: {
          result:
            stored === null || stored === undefined
              ? Prisma.DbNull
              : (wellFormed(stored) as Prisma.InputJsonValue),
        },
      });
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
    /** Продукт аренды Ш2: обход «Админки» или раунд обучалки. */
    product: 'assist-admin' | 'tutorial';
  }> {
    const row = await this.leased(jobId, token);
    if (!needsCredentials(row) || !row.testAccountId || !row.hostId) {
      throw leaseLost();
    }
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
      product: row.kind === 'tutorial-explore' ? 'tutorial' : 'assist-admin',
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
    const conflict = () =>
      jobError(
        HttpStatus.CONFLICT,
        'WORKER_ARTIFACT_CONFLICT',
        'Этот артефакт задания уже загружается или загружен другим запросом',
      );
    // Аудит Ш3 P3: старый Blob (повтор попытки с тем же номером) удаляется
    // ДО загрузки нового — не вышло, запрос отклоняется (503, воркер
    // повторит), и строка по-прежнему указывает на существующий Blob:
    // сирот в хранилище не остаётся.
    if (prev) {
      try {
        await this.storage.remove(prev.pathname);
      } catch {
        throw jobError(
          HttpStatus.SERVICE_UNAVAILABLE,
          'WORKER_STORAGE_UNAVAILABLE',
          'Хранилище артефактов недоступно — повторите загрузку',
        );
      }
    }
    const pathname = artifactPathname({
      accountId: row.accountId,
      jobId,
      idx: a.idx,
      contentType: a.contentType,
    });
    try {
      await this.storage.put(pathname, body, a.contentType);
    } catch (e) {
      // Старый Blob уже удалён — строка без файла не нужна.
      if (prev)
        await db.siteBrowserArtifact.deleteMany({
          where: { id: prev.id, pathname: prev.pathname },
        });
      throw e;
    }
    const data = {
      pathname,
      contentType: a.contentType,
      bytes: body.length,
      sha256: createHash('sha256').update(body).digest('hex'),
      width: a.width,
      height: a.height,
      expiresAt: row.expiresAt,
    };
    /** Свой новый Blob — убрать: строку занял параллельный запрос. */
    const dropOwn = () =>
      this.storage.remove(pathname).catch(() => {
        this.logger.warn(`артефакт ${jobId}/${a.idx}: Blob не удалён`);
      });
    if (prev) {
      // Условно: параллельная загрузка того же номера уже заменила строку —
      // 409, а не «последний победил» с потерянным Blob.
      const { count } = await db.siteBrowserArtifact.updateMany({
        where: { id: prev.id, pathname: prev.pathname },
        data,
      });
      if (count !== 1) {
        await dropOwn();
        throw conflict();
      }
    } else {
      try {
        await db.siteBrowserArtifact.create({
          data: { ...data, accountId: row.accountId, jobId, idx: a.idx },
        });
      } catch (e) {
        // Одновременная загрузка одного номера: (jobId, idx) уникален.
        if (
          e instanceof Prisma.PrismaClientKnownRequestError &&
          e.code === 'P2002'
        ) {
          await dropOwn();
          throw conflict();
        }
        throw e;
      }
    }
    return { ok: true, idx: a.idx, bytes: body.length };
  }

  // ── ретенция ───────────────────────────────────────────────────────────

  /**
   * Сроки: артефакты — по `expiresAt` (Blob, затем строка), задания — по
   * `expiresAt` (ожидавшие — с уведомлением продукта `job_timeout`).
   * Сначала — уборка (`reap`, без проверки выключателя): идущие с
   * истёкшей арендой закрываются, остальные идущие держит аренда.
   * Blob не удалился — строка артефакта (и задание, к которому она
   * привязана) остаётся до следующего прогона: иначе Blob стал бы сиротой
   * без ссылки на себя (аудит Ш3 P3).
   */
  async runRetention(
    now = this.now(),
    /** Только тесты на общей базе (`common/cron-scope.ts`): свои кабинеты. */
    scope: JobScope = null,
  ): Promise<{
    artifactsPurged: number;
    jobsPurged: number;
    blobErrors: number;
    reaped: ReapReport;
  }> {
    const reaped = await this.reap(now, scope);
    const db = this.sys('ретенция очереди и артефактов');
    const acc = scope ? { accountId: { in: scope.accountIds } } : {};
    let artifactsPurged = 0;
    let blobErrors = 0;
    /** Артефакты, чей Blob не удалился в этом прогоне (строки остаются). */
    const kept = new Set<string>();
    const keptJobs = new Set<string>();
    for (;;) {
      const batch = await db.siteBrowserArtifact.findMany({
        where: {
          expiresAt: { lte: now },
          ...acc,
          ...(kept.size ? { id: { notIn: [...kept] } } : {}),
        },
        take: 200,
        orderBy: { expiresAt: 'asc' },
      });
      if (!batch.length) break;
      for (const a of batch) {
        try {
          await this.storage.remove(a.pathname);
        } catch {
          blobErrors += 1;
          kept.add(a.id);
          keptJobs.add(a.jobId);
          continue;
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
        ...(kept.size ? { id: { notIn: [...kept] } } : {}),
      },
      take: 1000,
    });
    for (const a of leaving) {
      try {
        await this.storage.remove(a.pathname);
      } catch {
        blobErrors += 1;
        keptJobs.add(a.jobId);
        continue;
      }
      await db.siteBrowserArtifact.deleteMany({ where: { id: a.id } });
    }
    const { count } = await db.siteBrowserJob.deleteMany({
      where: {
        expiresAt: { lte: now },
        status: { not: 'running' },
        ...acc,
        ...(keptJobs.size ? { id: { notIn: [...keptJobs] } } : {}),
      },
    });
    return { artifactsPurged, jobsPurged: count, blobErrors, reaped };
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

/**
 * Нужна ли заданию учётка Ш2 (секреты — запросом воркера `credentials`):
 * обход «Админки» и раунд обучалки со входом учёткой реестра.
 */
export function needsCredentials(row: {
  kind: string;
  testAccountId: string | null;
}): boolean {
  return (
    row.kind === 'admin-crawl' ||
    (row.kind === 'tutorial-explore' && !!row.testAccountId)
  );
}

/** Номера артефактов, на которые ссылается результат. */
export function artifactRefs(result: unknown): number[] {
  const out: number[] = [];
  const r = result as {
    screenshot?: number | null;
    videoFrame?: number | null;
    frames?: Array<{ artifact: number }>;
    states?: Array<{ screenshot: number | null }>;
  };
  if (typeof r.screenshot === 'number') out.push(r.screenshot);
  if (typeof r.videoFrame === 'number') out.push(r.videoFrame);
  if (Array.isArray(r.frames)) for (const f of r.frames) out.push(f.artifact);
  // Ш3 (5): скриншоты состояний раскрывашек «Снимка».
  if (Array.isArray(r.states))
    for (const st of r.states)
      if (typeof st.screenshot === 'number') out.push(st.screenshot);
  return out;
}
