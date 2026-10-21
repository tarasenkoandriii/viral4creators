/**
 * Журнал действий оператора вкладки «FFmpeg» (`ffmpeg_operator_actions`,
 * ТЗ FFmpeg-server v1.1 §13.1).
 *
 * - Запрос пишется ДО отправки на сервер (`phase = requested`), исход —
 *   отдельной строкой ПОСЛЕ (`succeeded | failed | unknown`). Таблица
 *   append-only (UPDATE запрещён триггером), поэтому исход — не правка
 *   строки запроса, а вторая строка с тем же `operationId`.
 * - `operationId` — UUID от клиента и ключ идемпотентности мутации:
 *   повтор клика/refresh с тем же id не выполняет действие второй раз,
 *   а возвращает записанный исход (или «результат неизвестен, сверяем»).
 * - В журнал не попадают токены, команды, URL и тексты: `result`
 *   проходит `sanitizeOps`, причина ограничена 500 символами.
 * - Хранение 90 дней: `pruneFfmpegOperatorActions` из суточного крона
 *   `cleanup-sessions` (по образцу соседних уборок).
 */

import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { sanitizeOps } from './ffmpeg-ops.client';

export const FFMPEG_OPERATOR_RETENTION_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

export const FFMPEG_OPERATOR_ACTIONS = [
  'pause',
  'drain',
  'resume',
  'job.cancel',
  'job.purge',
  'job.reconcile',
  'job.download-link',
  'limits.update',
  'routing.update',
] as const;
export type FfmpegOperatorActionName = (typeof FFMPEG_OPERATOR_ACTIONS)[number];
export type FfmpegOutcomePhase = 'succeeded' | 'failed' | 'unknown';

export interface FfmpegJournalRequest {
  operationId: string;
  actorUserId: string;
  action: FfmpegOperatorActionName;
  jobId?: string | null;
  clientOperationId?: string | null;
  reason?: string | null;
  oldRevision?: number | null;
  correlationId: string;
}

export interface FfmpegJournalEntry {
  id: string;
  operationId: string;
  phase: string;
  actorUserId: string;
  action: string;
  jobId: string | null;
  clientOperationId: string | null;
  reason: string | null;
  oldRevision: number | null;
  newRevision: number | null;
  result: unknown;
  correlationId: string;
  createdAt: Date;
}

/** Предыдущий исход той же операции (повтор с тем же `operationId`). */
export type FfmpegJournalReplay =
  | { kind: 'fresh' }
  | {
      kind: 'replay';
      phase: FfmpegOutcomePhase | 'requested';
      result: unknown;
      newRevision: number | null;
      correlationId: string;
      /** Когда записан запрос (первая строка операции). */
      requestedAt: Date;
    };

export function ffmpegOperatorCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - FFMPEG_OPERATOR_RETENTION_DAYS * DAY_MS);
}

/** Удалить записи старше 90 дней; возвращает число удалённых. */
export async function pruneFfmpegOperatorActions(
  prisma: Pick<PrismaService, 'ffmpegOperatorAction'>,
  now: Date = new Date(),
): Promise<number> {
  const r = await prisma.ffmpegOperatorAction.deleteMany({
    where: { createdAt: { lt: ffmpegOperatorCutoff(now) } },
  });
  return r.count;
}

/** События fallback к hosted (счётчик вкладки) — 30 дней. */
export const FFMPEG_FALLBACK_RETENTION_DAYS = 30;

export async function pruneFfmpegFallbackEvents(
  prisma: Pick<PrismaService, 'ffmpegFallbackEvent'>,
  now: Date = new Date(),
): Promise<number> {
  const r = await prisma.ffmpegFallbackEvent.deleteMany({
    where: {
      createdAt: {
        lt: new Date(now.getTime() - FFMPEG_FALLBACK_RETENTION_DAYS * DAY_MS),
      },
    },
  });
  return r.count;
}

/**
 * Отправки (`ffmpeg_submissions`) и учтённые breaker задачи
 * (`ffmpeg_breaker_jobs`) — 30 дней: дольше любого повтора операции и
 * TTL результатов сервера (24 ч).
 */
export const FFMPEG_SUBMISSION_RETENTION_DAYS = 30;

export async function pruneFfmpegSubmissions(
  prisma: Pick<PrismaService, 'ffmpegSubmission' | 'ffmpegBreakerJob'>,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(
    now.getTime() - FFMPEG_SUBMISSION_RETENTION_DAYS * DAY_MS,
  );
  const [a, b] = await Promise.all([
    prisma.ffmpegSubmission.deleteMany({
      where: { createdAt: { lt: cutoff } },
    }),
    prisma.ffmpegBreakerJob.deleteMany({
      where: { createdAt: { lt: cutoff } },
    }),
  ]);
  return a.count + b.count;
}

const PHASE_ORDER = ['succeeded', 'failed', 'unknown'] as const;

function isUniqueViolation(err: unknown): boolean {
  return (
    !!err &&
    typeof err === 'object' &&
    (err as { code?: string }).code === 'P2002'
  );
}

@Injectable()
export class FfmpegOperatorJournal {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Записать запрос ДО отправки. Если операция с этим id уже была —
   * действие не повторяется: вернуть её исход. Тот же id у другого
   * действия/задачи/автора — 409.
   */
  async begin(req: FfmpegJournalRequest): Promise<FfmpegJournalReplay> {
    const existing = await this.replay(req);
    if (existing) return existing;
    try {
      await this.prisma.ffmpegOperatorAction.create({
        data: {
          operationId: req.operationId,
          phase: 'requested',
          actorUserId: req.actorUserId,
          action: req.action,
          jobId: req.jobId ?? null,
          clientOperationId: req.clientOperationId ?? null,
          reason: req.reason?.slice(0, 500) ?? null,
          oldRevision: req.oldRevision ?? null,
          correlationId: req.correlationId,
        },
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // Параллельный двойной клик: запись уже сделал соседний запрос.
      const raced = await this.replay(req);
      if (raced) return raced;
      throw err;
    }
    return { kind: 'fresh' };
  }

  private async replay(
    req: FfmpegJournalRequest,
  ): Promise<FfmpegJournalReplay | null> {
    const rows = await this.prisma.ffmpegOperatorAction.findMany({
      where: { operationId: req.operationId },
      orderBy: { createdAt: 'asc' },
    });
    if (rows.length === 0) return null;
    const first = rows[0];
    if (
      first.action !== req.action ||
      (first.jobId ?? null) !== (req.jobId ?? null) ||
      first.actorUserId !== req.actorUserId
    )
      throw new ConflictException({
        message:
          'Этот operationId уже использован для другого действия — обновите экран',
        code: 'FFMPEG_OPERATION_ID_REUSED',
      });
    const outcome = PHASE_ORDER.map((p) =>
      rows.find((r) => r.phase === p),
    ).find(Boolean);
    return {
      kind: 'replay',
      phase: (outcome?.phase ?? 'requested') as
        | FfmpegOutcomePhase
        | 'requested',
      result: outcome?.result ?? null,
      newRevision: outcome?.newRevision ?? null,
      correlationId: first.correlationId,
      requestedAt: first.createdAt,
    };
  }

  /** Записать исход ПОСЛЕ ответа сервера (или его отсутствия). */
  async finish(
    req: FfmpegJournalRequest,
    phase: FfmpegOutcomePhase,
    result: unknown,
    newRevision?: number | null,
  ): Promise<void> {
    try {
      await this.prisma.ffmpegOperatorAction.create({
        data: {
          operationId: req.operationId,
          phase,
          actorUserId: req.actorUserId,
          action: req.action,
          jobId: req.jobId ?? null,
          clientOperationId: req.clientOperationId ?? null,
          reason: req.reason?.slice(0, 500) ?? null,
          oldRevision: req.oldRevision ?? null,
          newRevision: newRevision ?? null,
          result: (sanitizeOps(result) ??
            Prisma.JsonNull) as Prisma.InputJsonValue,
          correlationId: req.correlationId,
        },
      });
    } catch (err) {
      // Второй исход той же операции (гонка) — первый остаётся в силе.
      if (!isUniqueViolation(err)) throw err;
    }
  }

  /** Последние записи (по задаче или по действиям обслуживания). */
  async history(opts: {
    jobId?: string;
    actions?: readonly FfmpegOperatorActionName[];
    limit?: number;
  }): Promise<FfmpegJournalEntry[]> {
    const rows = await this.prisma.ffmpegOperatorAction.findMany({
      where: {
        ...(opts.jobId ? { jobId: opts.jobId } : {}),
        ...(opts.actions ? { action: { in: [...opts.actions] } } : {}),
        createdAt: { gte: ffmpegOperatorCutoff() },
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(opts.limit ?? 20, 1), 100),
    });
    return rows as FfmpegJournalEntry[];
  }
}
