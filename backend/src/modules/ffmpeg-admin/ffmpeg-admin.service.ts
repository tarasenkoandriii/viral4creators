/**
 * Вкладка «FFmpeg» в существующей админке — серверная часть (ТЗ
 * FFmpeg-server v1.1 §13.1). Браузер → `/api/admin/ffmpeg/*` → этот
 * сервис → собственный ffmpeg-server (`/api/ops/*`, `/api/control/*`,
 * `/api/jobs/*`). Ключ сервера остаётся secret backend.
 *
 * - GET ничего не меняет ни у нас, ни на сервере.
 * - Недоступный сервер → `state: 'stale' | 'error'` с причиной и
 *   временем последних данных, НЕ пустая очередь (§13.1 п.1).
 * - Мутации: `operationId` (UUID клиента) = Idempotency-Key запроса к
 *   серверу и ключ журнала; запрос пишется в журнал до отправки, исход —
 *   после; обрыв → `outcome: 'unknown'` («результат неизвестен,
 *   сверяем»), без повтора с новым ключом.
 * - Маршрутизация и лимиты — CAS по ревизии; устаревшая → 409.
 *   Маршрутизация касается только новых задач.
 * - Повторного рендера нет (§13.1): ни одна ветка не вызывает submit.
 */

import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import {
  FFMPEG_PRODUCTS,
  FfmpegApiService,
  FfmpegProduct,
  FfmpegProvider,
  SELFHOSTED_JOB_PREFIX,
  FFMPEG_BREAKER_THRESHOLD,
  ffmpegProviderOfJobId,
} from '../postprod/ffmpeg-api.service';
import {
  FfmpegOpsClient,
  FfmpegOpsRejected,
  FfmpegOpsUnavailable,
  sanitizeOps,
} from './ffmpeg-ops.client';
import {
  FfmpegJournalRequest,
  FfmpegOperatorActionName,
  FfmpegOperatorJournal,
} from './ffmpeg-operator-journal';
import { findFfmpegJobOwners } from './ffmpeg-job-owner';

/** id задачи в маршруте: hosted как есть или `selfhosted:<id сервера>`. */
export const FFMPEG_ADMIN_JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const SERVER_JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const OPERATION_KEY = /^[\x21-\x7e]{1,128}$/;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const PAGE_SIZE = 25;
/**
 * Сколько запрос «в работе» (`requested` без исхода) считается ещё
 * выполняющимся: мутация делает ≤2 запроса к серверу по 5 с плюс БД.
 */
export const FFMPEG_IN_PROGRESS_MS = 20_000;
const USAGE_CACHE_MS = 60_000;

export const FFMPEG_JOB_STATES = [
  'queued',
  'processing',
  'succeeded',
  'failed',
  'canceled',
] as const;
export const FFMPEG_PERIODS = ['24h', '7d', '30d', '90d'] as const;

/**
 * Лимиты, которые оператор может менять (имена `LimitsProfile` из
 * `ffmpeg-server/src/contracts.ts`, без `revision`). Concurrency в этом
 * списке нет и быть не может: рост выше 1 на общем VPS UI не разрешает.
 */
export const FFMPEG_EDITABLE_LIMITS = [
  'maxInputs',
  'maxCommands',
  'maxOutputs',
  'maxCommandsTextBytes',
  'maxInputBytes',
  'maxTotalInputBytes',
  'maxTotalOutputBytes',
  'maxWorkspaceBytes',
  'maxWidth',
  'maxHeight',
  'maxFps',
  'maxInputDurationSec',
  'maxImagePixels',
  'pipelineDeadlineSec',
  'queueDeadlineSec',
  'downloadFileDeadlineSec',
  'downloadConnectTimeoutSec',
  'downloadStallTimeoutSec',
  'maxThreads',
  'stderrTailBytes',
] as const;

const MAINTENANCE_ACTIONS: readonly FfmpegOperatorActionName[] = [
  'pause',
  'drain',
  'resume',
  'limits.update',
  'routing.update',
];

export type SnapshotState = 'ok' | 'stale' | 'error' | 'not-configured';

export interface Snapshot<T> {
  state: SnapshotState;
  /** Время получения данных (у stale — последних удачных). */
  fetchedAt: string | null;
  error: string | null;
  data: T | null;
}

export interface MutationOutcome {
  operationId: string;
  correlationId: string;
  action: FfmpegOperatorActionName;
  /** `in_progress` — первый запрос с этим id ещё выполняется (HTTP 202). */
  outcome: 'succeeded' | 'failed' | 'unknown' | 'in_progress';
  /** Повтор уже записанной операции: действие НЕ выполнялось заново. */
  replayed: boolean;
  message: string;
  result: unknown;
}

interface RunResult {
  /** Что пишется в журнал (будет очищено от секретов). */
  journal: unknown;
  /** Что уходит в ответ админке (уже без секретов сервера). */
  response: unknown;
  newRevision?: number | null;
}

interface Actor {
  userId: string;
}

function productOfClientOperation(id: unknown): FfmpegProduct | null {
  if (typeof id !== 'string') return null;
  const prefix = id.split(':', 1)[0];
  return (FFMPEG_PRODUCTS as readonly string[]).includes(prefix)
    ? (prefix as FfmpegProduct)
    : null;
}

@Injectable()
export class FfmpegAdminService {
  private readonly lastGood = new Map<string, { at: Date; data: unknown }>();
  private usageCache: { at: number; data: Record<string, number> } | null =
    null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly ffmpeg: FfmpegApiService,
    private readonly ops: FfmpegOpsClient,
    private readonly journal: FfmpegOperatorJournal,
  ) {}

  // ── чтение ────────────────────────────────────────────────────────

  /** Настроены адрес и ops-ключ своего сервера (для дашборда внимания). */
  opsConfigured(): boolean {
    const c = this.ops.configuration();
    return c.baseUrl && c.opsKey;
  }

  /** Данные сервера с явным stale/error вместо пустоты. */
  private async snapshot<T>(
    cacheKey: string,
    load: () => Promise<T>,
  ): Promise<Snapshot<T>> {
    try {
      const data = await load();
      const at = new Date();
      // Кэш последних удачных данных ограничен: ключи списков зависят от
      // фильтров и курсора.
      if (this.lastGood.size >= 200 && !this.lastGood.has(cacheKey))
        this.lastGood.delete(this.lastGood.keys().next().value as string);
      this.lastGood.set(cacheKey, { at, data });
      return { state: 'ok', fetchedAt: at.toISOString(), error: null, data };
    } catch (err) {
      const message =
        err instanceof FfmpegOpsUnavailable || err instanceof FfmpegOpsRejected
          ? err.message
          : 'Не удалось получить данные FFmpeg-сервера';
      if (err instanceof FfmpegOpsUnavailable && err.kind === 'not-configured')
        return {
          state: 'not-configured',
          fetchedAt: null,
          error: message,
          data: null,
        };
      const last = this.lastGood.get(cacheKey);
      if (last)
        return {
          state: 'stale',
          fetchedAt: last.at.toISOString(),
          error: message,
          data: last.data as T,
        };
      return { state: 'error', fetchedAt: null, error: message, data: null };
    }
  }

  async routingView() {
    const stored = await this.ffmpeg.readRouting();
    const gateEnabled = this.ffmpeg.selfhostedEnabled();
    const configured = this.ffmpeg.selfhostedConfigured();
    const active = gateEnabled && configured;
    const storedDefault: FfmpegProvider = stored?.defaultProvider ?? 'hosted';
    const canary = stored?.canaryProducts ?? [];
    const openUntil = stored?.breakerOpenUntil ?? null;
    const breakerOpen = !!openUntil && openUntil.getTime() > Date.now();
    const fallback = this.ffmpeg.fallbackEnabled();
    return {
      revision: stored?.revision ?? null,
      defaultProvider: storedDefault,
      canaryProducts: stored?.canaryProducts ?? [],
      updatedAt: stored?.updatedAt?.toISOString() ?? null,
      updatedBy: stored?.updatedBy ?? null,
      /** Env-гейт FFMPEG_SELFHOSTED_ENABLED (меняется только деплоем). */
      selfhostedGateEnabled: gateEnabled,
      selfhostedConfigured: configured,
      /**
       * Что реально получит НОВАЯ задача: без гейта/строки — hosted;
       * непустой canary — к своему серверу только эти продукты; открытый
       * breaker при доступном fallback — hosted.
       */
      effectiveDefaultProvider:
        active && stored && canary.length === 0 && !(breakerOpen && fallback)
          ? storedDefault
          : ('hosted' as const),
      effectiveCanaryProducts:
        active && stored && !(breakerOpen && fallback) ? canary : [],
      /** FFMPEG_FALLBACK_HOSTED и наличие FFMPEG_API_KEY. */
      fallbackToHosted: fallback,
      breaker: {
        failures: stored?.breakerFailures ?? 0,
        threshold: FFMPEG_BREAKER_THRESHOLD,
        open: breakerOpen,
        openUntil: openUntil?.toISOString() ?? null,
        probeUntil: stored?.breakerProbeUntil?.toISOString() ?? null,
      },
      products: [...FFMPEG_PRODUCTS],
      scope:
        'Только новые задачи: принятые остаются у провайдера из префикса своего id',
    };
  }

  private async usage24h(): Promise<Record<string, number>> {
    if (this.usageCache && Date.now() - this.usageCache.at < USAGE_CACHE_MS)
      return this.usageCache.data;
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const count = (provider: string) =>
      this.prisma.aiUsage.count({
        where: { createdAt: { gte: since }, provider },
      });
    const [hosted, selfhosted, fallbacks] = await Promise.all([
      count('FFMPEG'),
      count('FFMPEG_SELFHOSTED'),
      this.prisma.ffmpegFallbackEvent.count({
        where: { createdAt: { gte: since } },
      }),
    ]);
    const data: Record<string, number> = { hosted, selfhosted, fallbacks };
    this.usageCache = { at: Date.now(), data };
    return data;
  }

  async overview() {
    const [routing, selfhosted, usage] = await Promise.all([
      this.routingView(),
      this.snapshot('overview', async () =>
        sanitizeOps(
          await this.ops.request('GET', '/ops/overview', { role: 'ops' }),
        ),
      ),
      this.usage24h().catch(() => null),
    ]);
    return {
      generatedAt: new Date().toISOString(),
      routing,
      selfhosted: { ...selfhosted, configuration: this.ops.configuration() },
      hosted: {
        configured: this.ffmpeg.hostedConfigured(),
        note: 'Внешний провайдер не отдаёт очередь: задачи без префикса id опрашиваются у него до завершения или истечения',
      },
      /** Вызовы ffmpeg за 24 ч по журналу расходов (расчёт, не счёт провайдера). */
      usage24h: usage
        ? { hosted: usage.hosted, selfhosted: usage.selfhosted }
        : null,
      /** Новые задачи, ушедшие к hosted вместо своего сервера, за 24 ч. */
      fallbacks24h: usage ? usage.fallbacks : null,
    };
  }

  async jobs(q: {
    provider?: 'hosted' | 'selfhosted';
    state?: string;
    product?: string;
    period?: string;
    clientOperationId?: string;
    jobId?: string;
    cursor?: string;
  }) {
    if (q.jobId && !FFMPEG_ADMIN_JOB_ID.test(q.jobId))
      throw new BadRequestException('Неверный id задачи');
    const provider =
      q.provider ?? (q.jobId ? ffmpegProviderOfJobId(q.jobId) : 'selfhosted');
    if (provider === 'hosted') {
      // У внешнего провайдера нет списка задач: показываем одну по id.
      if (!q.jobId)
        return {
          provider,
          state: 'unsupported' as const,
          fetchedAt: null,
          error:
            'Внешний провайдер не отдаёт список задач — найдите задачу по id',
          items: null,
          nextCursor: null,
        };
      const card = await this.hostedStatus(q.jobId);
      return {
        provider,
        state: card.state,
        fetchedAt: card.fetchedAt,
        error: card.error,
        items: card.data
          ? [{ jobId: q.jobId, provider, ...(card.data as object) }]
          : null,
        nextCursor: null,
      };
    }
    const serverJobId = q.jobId?.startsWith(SELFHOSTED_JOB_PREFIX)
      ? q.jobId.slice(SELFHOSTED_JOB_PREFIX.length)
      : q.jobId;
    const snap = await this.snapshot(`jobs:${JSON.stringify(q)}`, async () =>
      this.ops.request('GET', '/ops/jobs', {
        role: 'ops',
        query: {
          limit: String(PAGE_SIZE),
          cursor: q.cursor,
          state: q.state,
          period: q.period ?? '24h',
          client_operation_id: q.clientOperationId,
          job_id: serverJobId,
        },
      }),
    );
    if (!snap.data)
      return {
        provider,
        state: snap.state,
        fetchedAt: snap.fetchedAt,
        error: snap.error,
        items: null,
        nextCursor: null,
      };
    const raw = snap.data;
    const list = Array.isArray(raw.items)
      ? raw.items
      : Array.isArray(raw.jobs)
        ? raw.jobs
        : [];
    let items = list
      .filter((j): j is Record<string, unknown> => !!j && typeof j === 'object')
      .map((j) => {
        const clean = sanitizeOps(j) as Record<string, unknown>;
        const id = typeof j.id === 'string' ? j.id : String(j.job_id ?? '');
        return {
          ...clean,
          jobId: `${SELFHOSTED_JOB_PREFIX}${id}`,
          providerJobId: id,
          provider: 'selfhosted' as const,
          product: productOfClientOperation(j.client_operation_id),
        };
      });
    // Продукт передаётся префиксом X-Client-Operation-Id; фильтр ops-API
    // по продукту не объявлен (Р-FF-5) — сужаем страницу здесь.
    if (q.product) items = items.filter((i) => i.product === q.product);
    const next = raw.next_cursor ?? raw.nextCursor ?? null;
    return {
      provider,
      state: snap.state,
      fetchedAt: snap.fetchedAt,
      error: snap.error,
      items,
      nextCursor: typeof next === 'string' ? next : null,
      productFilter: q.product ? ('page' as const) : null,
    };
  }

  private async hostedStatus(jobId: string): Promise<Snapshot<unknown>> {
    if (!this.ffmpeg.hostedConfigured())
      return {
        state: 'not-configured',
        fetchedAt: null,
        error: 'FFMPEG_API_KEY не задан',
        data: null,
      };
    return this.snapshot(`hosted:${jobId}`, async () => {
      const st = await this.ffmpeg
        .status(jobId, 5_000, { retry: false })
        .catch(() => {
          throw new FfmpegOpsUnavailable(
            'upstream',
            'Внешний FFmpeg-провайдер не ответил или не знает задачу',
          );
        });
      return {
        status: st.status,
        errorCode: st.errorCode ?? null,
        error: st.error
          ? (sanitizeOps(st.error) as string).slice(0, 500)
          : null,
        outputNames: st.outputs ? Object.keys(st.outputs) : [],
      };
    });
  }

  private assertJobId(id: string): FfmpegProvider {
    if (!FFMPEG_ADMIN_JOB_ID.test(id))
      throw new BadRequestException('Неверный id задачи');
    const provider = ffmpegProviderOfJobId(id);
    if (
      provider === 'selfhosted' &&
      !SERVER_JOB_ID.test(id.slice(SELFHOSTED_JOB_PREFIX.length))
    )
      throw new BadRequestException('Неверный id задачи');
    return provider;
  }

  private serverId(id: string): string {
    return id.slice(SELFHOSTED_JOB_PREFIX.length);
  }

  async job(id: string) {
    const provider = this.assertJobId(id);
    const [card, owners, actions] = await Promise.all([
      provider === 'selfhosted'
        ? this.snapshot(`job:${id}`, async () =>
            sanitizeOps(
              await this.ops.request(
                'GET',
                `/ops/jobs/${encodeURIComponent(this.serverId(id))}`,
                { role: 'ops' },
              ),
            ),
          )
        : this.hostedStatus(id),
      findFfmpegJobOwners(this.prisma, id).catch(() => []),
      this.journal.history({ jobId: id, limit: 50 }).catch(() => []),
    ]);
    if (card.data && typeof card.data === 'object') {
      const d = card.data as Record<string, unknown>;
      if (typeof d.client_operation_id === 'string')
        d.product = productOfClientOperation(d.client_operation_id);
    }
    return {
      jobId: id,
      provider,
      ...card,
      owners,
      actions,
    };
  }

  async limits() {
    const [snap, history] = await Promise.all([
      this.snapshot('limits', async () =>
        sanitizeOps(
          await this.ops.request('GET', '/ops/limits', { role: 'ops' }),
        ),
      ),
      this.journal
        .history({ actions: MAINTENANCE_ACTIONS, limit: 20 })
        .catch(() => []),
    ]);
    return {
      ...snap,
      editable: [...FFMPEG_EDITABLE_LIMITS],
      routing: await this.routingView(),
      history,
    };
  }

  // ── мутации ───────────────────────────────────────────────────────

  private async mutate(
    req: FfmpegJournalRequest,
    run: () => Promise<RunResult>,
    opts: {
      /** Поля, которые журнал фиксирует при любом исходе (например `reconciled`). */
      extra?: Record<string, unknown>;
      /**
       * FF-INT-06: повтор после неподтверждённого исхода сперва читает
       * фактическое состояние сервера. Вернул результат — действие уже
       * применено, повторно не выполняется; `null` — выполнить.
       */
      verify?: () => Promise<RunResult | null>;
    } = {},
  ): Promise<MutationOutcome> {
    const extra = opts.extra ?? {};
    const base = {
      operationId: req.operationId,
      action: req.action,
    };
    const replay = await this.journal.begin(req);
    // FF-INT-16: первый запрос с этим id ещё в работе — не выполнять
    // действие второй раз и не писать второй исход.
    if (
      replay.kind === 'replay' &&
      replay.phase === 'requested' &&
      Date.now() - replay.requestedAt.getTime() < FFMPEG_IN_PROGRESS_MS
    )
      return {
        ...base,
        correlationId: replay.correlationId,
        outcome: 'in_progress',
        replayed: true,
        message: 'Операция с этим id ещё выполняется — дождитесь результата',
        result: null,
      };
    // Повтор при неподтверждённом исходе (unknown или запрос, зависший
    // дольше срока) сверяет фактическое состояние, а не возвращает «unknown».
    const recheck =
      replay.kind === 'replay' &&
      (replay.phase === 'requested' || replay.phase === 'unknown');
    if (replay.kind === 'replay' && !recheck) {
      const outcome = replay.phase === 'requested' ? 'unknown' : replay.phase;
      return {
        ...base,
        correlationId: replay.correlationId,
        outcome,
        replayed: true,
        message:
          outcome === 'unknown'
            ? 'Операция уже отправлялась, исход не подтверждён — сверяем, повторно не выполняется'
            : 'Операция уже выполнялась — показан записанный исход',
        result: replay.result,
      };
    }
    try {
      const verified = recheck && opts.verify ? await opts.verify() : null;
      const r = verified ?? (await run());
      await this.journal.finish(
        req,
        'succeeded',
        r.journal && typeof r.journal === 'object' && !Array.isArray(r.journal)
          ? { ...extra, ...(r.journal as object) }
          : Object.keys(extra).length
            ? { ...extra, value: r.journal }
            : r.journal,
        r.newRevision,
      );
      return {
        ...base,
        correlationId: req.correlationId,
        outcome: 'succeeded',
        replayed: false,
        message: verified
          ? 'Сверено: действие уже применено на сервере, повторно не выполнялось'
          : 'Выполнено',
        result: r.response,
      };
    } catch (err) {
      if (err instanceof FfmpegOpsRejected) {
        await this.journal.finish(req, 'failed', {
          ...extra,
          status: err.status,
          code: err.code ?? null,
          message: err.message,
        });
        throw this.rejection(err);
      }
      if (err instanceof FfmpegOpsUnavailable) {
        if (err.kind === 'not-configured') {
          await this.journal.finish(req, 'failed', {
            ...extra,
            code: 'FFMPEG_NOT_CONFIGURED',
          });
          throw new ServiceUnavailableException({
            message: err.message,
            code: 'FFMPEG_NOT_CONFIGURED',
          });
        }
        await this.journal.finish(req, 'unknown', {
          ...extra,
          kind: err.kind,
          status: err.status ?? null,
        });
        return {
          ...base,
          correlationId: req.correlationId,
          outcome: 'unknown',
          replayed: false,
          message: `Результат неизвестен, сверяем: ${err.message}`,
          result: null,
        };
      }
      if (err instanceof HttpException) {
        await this.journal.finish(req, 'failed', {
          ...extra,
          status: err.getStatus(),
          message: err.message,
        });
        throw err;
      }
      await this.journal
        .finish(req, 'unknown', { ...extra, kind: 'internal' })
        .catch(() => undefined);
      throw err;
    }
  }

  private rejection(err: FfmpegOpsRejected): HttpException {
    if (err.code === 'NOT_RECONCILED')
      return new ConflictException({
        message:
          'Сервер в режиме recovery: продолжить можно только после сверки задач — resume с reconciled: true (право ffmpeg.configure, причина обязательна)',
        code: 'NOT_RECONCILED',
      });
    if (err.status === 409)
      return new ConflictException({
        message:
          err.code === 'STALE_REVISION' || err.code === 'REVISION_CONFLICT'
            ? 'Данные устарели: ревизия изменилась — обновите экран'
            : err.message,
        code: err.code ?? 'FFMPEG_CONFLICT',
      });
    if (err.status === 404)
      return new NotFoundException({
        message: 'FFmpeg-сервер не знает эту задачу',
        code: err.code ?? 'FFMPEG_NOT_FOUND',
      });
    return new HttpException(
      { message: err.message, code: err.code ?? 'FFMPEG_REJECTED' },
      err.status >= 400 && err.status < 500 ? err.status : 400,
    );
  }

  private request(
    actor: Actor,
    action: FfmpegOperatorActionName,
    operationId: string,
    extra: Partial<FfmpegJournalRequest> = {},
  ): FfmpegJournalRequest {
    return {
      operationId: operationId.toLowerCase(),
      actorUserId: actor.userId,
      action,
      correlationId: randomUUID(),
      ...extra,
    };
  }

  async control(
    actor: Actor,
    action: 'pause' | 'drain' | 'resume',
    body: { operationId: string; reason?: string; reconciled?: boolean },
  ): Promise<MutationOutcome> {
    // Выход из recovery (CORE): только resume с reconciled: true и причиной;
    // право configure проверяет контроллер.
    const reconciled = action === 'resume' && body.reconciled === true;
    if (reconciled && !(body.reason && /(?:\s*\S){3}/.test(body.reason)))
      throw new BadRequestException({
        message: 'Выход из recovery требует причины (3–500 символов)',
        code: 'FFMPEG_REASON_REQUIRED',
      });
    const req = this.request(actor, action, body.operationId, {
      reason: body.reason ?? null,
    });
    const payload: Record<string, unknown> = {};
    if (body.reason) payload.reason = body.reason;
    if (reconciled) payload.reconciled = true;
    return this.mutate(
      req,
      async () => {
        const data = await this.ops.request('POST', `/control/${action}`, {
          role: 'ops',
          body: payload,
          idempotencyKey: req.operationId,
          correlationId: req.correlationId,
        });
        const clean = sanitizeOps(data);
        return { journal: clean, response: clean };
      },
      {
        extra: reconciled ? { reconciled: true } : {},
        verify: async () => {
          const ov = await this.ops.request('GET', '/ops/overview', {
            role: 'ops',
            correlationId: req.correlationId,
          });
          const mode = (ov.control as { mode?: unknown } | undefined)?.mode;
          const expected = {
            pause: 'paused',
            drain: 'drained',
            resume: 'active',
          }[action];
          return mode === expected
            ? {
                journal: { verified: true, mode },
                response: { verified: true, control: sanitizeOps(ov.control) },
              }
            : null;
        },
      },
    );
  }

  private requireSelfhosted(id: string, what: string): void {
    if (this.assertJobId(id) !== 'selfhosted')
      throw new BadRequestException({
        message: `${what} доступно только для задач своего сервера (id selfhosted:…); задачу внешнего провайдера ведите в его кабинете`,
        code: 'FFMPEG_HOSTED_UNSUPPORTED',
      });
  }

  async cancel(
    actor: Actor,
    id: string,
    body: { operationId: string; reason: string },
  ): Promise<MutationOutcome> {
    this.requireSelfhosted(id, 'Отмена');
    const req = this.request(actor, 'job.cancel', body.operationId, {
      jobId: id,
      reason: body.reason,
    });
    return this.mutate(
      req,
      async () => {
        const data = await this.ops.request(
          'POST',
          `/jobs/${encodeURIComponent(this.serverId(id))}/cancel`,
          {
            role: 'client',
            body: {},
            idempotencyKey: req.operationId,
            correlationId: req.correlationId,
          },
        );
        const clean = sanitizeOps(data);
        return { journal: clean, response: clean };
      },
      {
        verify: async () => {
          const job = await this.ops.request(
            'GET',
            `/jobs/${encodeURIComponent(this.serverId(id))}`,
            { role: 'client', correlationId: req.correlationId },
          );
          const st = job.status;
          if (st === 'canceled' || st === 'cancelled')
            return {
              journal: { verified: true, status: st },
              response: { verified: true, status: st },
            };
          if (st === 'succeeded' || st === 'failed')
            throw new ConflictException({
              message: `Задача уже завершилась (${st}) — отмена не применена`,
              code: 'FFMPEG_JOB_TERMINAL',
            });
          return null;
        },
      },
    );
  }

  async purge(
    actor: Actor,
    id: string,
    body: { operationId: string; reason: string; confirmIrreversible: boolean },
  ): Promise<MutationOutcome> {
    this.requireSelfhosted(id, 'Удаление временных файлов');
    if (body.confirmIrreversible !== true)
      throw new BadRequestException({
        message: 'Удаление необратимо — нужно явное подтверждение',
        code: 'FFMPEG_CONFIRMATION_REQUIRED',
      });
    const req = this.request(actor, 'job.purge', body.operationId, {
      jobId: id,
      reason: body.reason,
    });
    return this.mutate(req, async () => {
      const res = await this.ops.requestWithStatus(
        'DELETE',
        `/jobs/${encodeURIComponent(this.serverId(id))}/artifacts`,
        {
          role: 'client',
          idempotencyKey: req.operationId,
          correlationId: req.correlationId,
        },
      );
      const clean = {
        ...(sanitizeOps(res.data) as Record<string, unknown>),
        // 202 — ссылки отозваны, удаление ещё идёт; 200 — подтверждено.
        deletionConfirmed: res.status === 200,
      };
      return { journal: clean, response: clean };
    });
  }

  async reconcile(
    actor: Actor,
    id: string,
    body: { operationId: string; idempotencyKey?: string; reason?: string },
  ): Promise<MutationOutcome> {
    const provider = this.assertJobId(id);
    if (
      body.idempotencyKey !== undefined &&
      !OPERATION_KEY.test(body.idempotencyKey)
    )
      throw new BadRequestException('Неверный ключ идемпотентности');
    if (body.idempotencyKey && provider !== 'selfhosted')
      throw new BadRequestException({
        message: 'Сверка по ключу — только у своего сервера',
        code: 'FFMPEG_HOSTED_UNSUPPORTED',
      });
    const req = this.request(actor, 'job.reconcile', body.operationId, {
      jobId: id,
      reason: body.reason ?? null,
    });
    // Только чтение: не рендерит, не зовёт hosted submit, не сбрасывает
    // UNKNOWN в queued; 404 по ключу — не повод отправить задачу заново.
    return this.mutate(req, async () => {
      if (provider === 'hosted') {
        const st = await this.ffmpeg
          .status(id, 5_000, { retry: false })
          .catch(() => {
            throw new FfmpegOpsUnavailable(
              'upstream',
              'Внешний FFmpeg-провайдер не ответил',
            );
          });
        const clean = {
          status: st.status,
          errorCode: st.errorCode ?? null,
          outputNames: st.outputs ? Object.keys(st.outputs) : [],
        };
        return { journal: clean, response: clean };
      }
      const path = body.idempotencyKey
        ? `/jobs/by-key/${encodeURIComponent(body.idempotencyKey)}`
        : `/jobs/${encodeURIComponent(this.serverId(id))}`;
      try {
        const data = await this.ops.request('GET', path, {
          role: 'client',
          correlationId: req.correlationId,
        });
        const clean = { found: true, ...(sanitizeOps(data) as object) };
        return { journal: clean, response: clean };
      } catch (err) {
        if (err instanceof FfmpegOpsRejected && err.status === 404) {
          const clean = {
            found: false,
            note: 'Записи нет в БД сервера. Это не разрешение отправить задачу другому провайдеру — нужна ручная сверка операции продукта.',
          };
          return { journal: clean, response: clean };
        }
        throw err;
      }
    });
  }

  async downloadLink(
    actor: Actor,
    id: string,
    body: { operationId: string; file: string; reason?: string },
  ): Promise<MutationOutcome> {
    this.requireSelfhosted(id, 'Ссылка на результат');
    if (!FILE_NAME.test(body.file))
      throw new BadRequestException('Неверное имя файла результата');
    const req = this.request(actor, 'job.download-link', body.operationId, {
      jobId: id,
      reason: body.reason ?? null,
    });
    return this.mutate(req, async () => {
      const data = await this.ops.request(
        'POST',
        `/ops/jobs/${encodeURIComponent(this.serverId(id))}/download-link`,
        {
          role: 'ops',
          body: { file: body.file },
          idempotencyKey: req.operationId,
          correlationId: req.correlationId,
        },
      );
      const url = typeof data.url === 'string' ? data.url : null;
      if (!url || !/^https:\/\//.test(url))
        throw new FfmpegOpsRejected(
          422,
          'FFMPEG_LINK_INVALID',
          'Сервер не выдал корректную ссылку',
          undefined,
        );
      const expiresAt =
        typeof data.expires_at === 'string'
          ? data.expires_at
          : typeof data.expiresAt === 'string'
            ? data.expiresAt
            : null;
      const mime = typeof data.mime === 'string' ? data.mime : null;
      return {
        // В журнал — без ссылки: токен выдачи не хранится нигде у нас.
        journal: { file: body.file, expiresAt, mime },
        response: { file: body.file, url, expiresAt, mime },
      };
    });
  }

  async updateLimits(
    actor: Actor,
    body: {
      operationId: string;
      expectedRevision: number;
      limits: Record<string, unknown>;
      reason?: string;
    },
  ): Promise<MutationOutcome> {
    const keys = Object.keys(body.limits ?? {});
    if (keys.length === 0)
      throw new BadRequestException('Нет изменённых лимитов');
    for (const k of keys) {
      if (!(FFMPEG_EDITABLE_LIMITS as readonly string[]).includes(k))
        throw new BadRequestException({
          message: /concurren|worker|slot/i.test(k)
            ? 'Concurrency из админки не меняется: на общем VPS она равна 1'
            : `Лимит «${k}» из админки не меняется`,
          code: 'FFMPEG_LIMIT_NOT_EDITABLE',
        });
      const v = body.limits[k];
      if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1)
        throw new BadRequestException(`Лимит «${k}»: нужно целое число ≥ 1`);
    }
    const req = this.request(actor, 'limits.update', body.operationId, {
      reason: body.reason ?? null,
      oldRevision: body.expectedRevision,
    });
    return this.mutate(
      req,
      async () => {
        const data = await this.ops.request('POST', '/ops/limits', {
          role: 'ops',
          body: {
            expected_revision: body.expectedRevision,
            limits: body.limits,
          },
          idempotencyKey: req.operationId,
          correlationId: req.correlationId,
        });
        const clean = sanitizeOps(data) as Record<string, unknown>;
        const rev = clean.revision;
        return {
          journal: { changed: keys, revision: rev ?? null },
          response: clean,
          newRevision: typeof rev === 'number' ? rev : null,
        };
      },
      {
        verify: async () => {
          const cur = sanitizeOps(
            await this.ops.request('GET', '/ops/limits', {
              role: 'ops',
              correlationId: req.correlationId,
            }),
          ) as Record<string, unknown>;
          const rev = typeof cur.revision === 'number' ? cur.revision : null;
          if (rev === body.expectedRevision) return null; // не применено
          if (
            rev !== null &&
            rev > body.expectedRevision &&
            keys.every((k) => cur[k] === body.limits[k])
          )
            return {
              journal: { verified: true, changed: keys, revision: rev },
              response: cur,
              newRevision: rev,
            };
          throw new ConflictException({
            message: 'Лимиты уже изменены другим действием — обновите экран',
            code: 'FFMPEG_STALE_REVISION',
          });
        },
      },
    );
  }

  async updateRouting(
    actor: Actor,
    body: {
      operationId: string;
      expectedRevision: number;
      defaultProvider: FfmpegProvider;
      canaryProducts: string[];
      confirmSelfhostedDefault?: boolean;
      reason?: string;
    },
  ): Promise<MutationOutcome> {
    const products = [...new Set(body.canaryProducts)];
    for (const p of products)
      if (!(FFMPEG_PRODUCTS as readonly string[]).includes(p))
        throw new BadRequestException(`Неизвестный продукт «${p}»`);
    const current = await this.ffmpeg.readRouting();
    if (!current)
      throw new ServiceUnavailableException({
        message: 'Таблица маршрутизации ffmpeg недоступна (миграция?)',
        code: 'FFMPEG_ROUTING_UNAVAILABLE',
      });
    // canary → default — отдельное подтверждение владельца (§13.1).
    if (
      body.defaultProvider === 'selfhosted' &&
      current.defaultProvider !== 'selfhosted' &&
      body.confirmSelfhostedDefault !== true
    )
      throw new BadRequestException({
        message:
          'Перевод всех новых задач на свой сервер требует отдельного подтверждения владельца (confirmSelfhostedDefault)',
        code: 'FFMPEG_DEFAULT_CONFIRMATION_REQUIRED',
      });
    const req = this.request(actor, 'routing.update', body.operationId, {
      reason: body.reason ?? null,
      oldRevision: body.expectedRevision,
    });
    return this.mutate(
      req,
      async () => {
        const updated = await this.prisma.ffmpegRouting.updateMany({
          where: { id: 'default', revision: body.expectedRevision },
          data: {
            revision: { increment: 1 },
            defaultProvider: body.defaultProvider,
            canaryProducts: products,
            updatedAt: new Date(),
            updatedBy: actor.userId,
          },
        });
        if (updated.count !== 1)
          throw new ConflictException({
            message:
              'Маршрутизацию уже изменили: ревизия устарела — обновите экран',
            code: 'FFMPEG_STALE_REVISION',
          });
        const view = await this.routingView();
        return {
          journal: {
            from: {
              defaultProvider: current.defaultProvider,
              canaryProducts: current.canaryProducts,
            },
            to: {
              defaultProvider: body.defaultProvider,
              canaryProducts: products,
            },
          },
          response: view,
          newRevision: view.revision,
        };
      },
      {
        verify: async () => {
          const cur = await this.ffmpeg.readRouting();
          if (!cur || cur.revision === body.expectedRevision) return null;
          const same =
            cur.revision === body.expectedRevision + 1 &&
            cur.updatedBy === actor.userId &&
            cur.defaultProvider === body.defaultProvider &&
            JSON.stringify(cur.canaryProducts) === JSON.stringify(products);
          if (!same)
            throw new ConflictException({
              message:
                'Маршрутизацию уже изменили: ревизия устарела — обновите экран',
              code: 'FFMPEG_STALE_REVISION',
            });
          const view = await this.routingView();
          return {
            journal: { verified: true, revision: cur.revision },
            response: view,
            newRevision: cur.revision,
          };
        },
      },
    );
  }
}
