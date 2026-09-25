/**
 * ApiVideoJobWorker — доводит заявки внешнего API до ролика (этап 145,
 * docs-tz/TZ-Vneshnee-API.md).
 *
 * Устроен как воркер пакетной генерации (`CatalogBatchWorkerService`) и
 * по той же причине: «сделать ролик без человека» в продукте уже
 * решено, и решать это второй раз своими руками значит завести второй
 * набор тех же ошибок. Отсюда и порядок тика: сначала двигаем то, что
 * уже рендерится, потом берём новое.
 *
 * ## Что делает заявка руками пользователя
 *
 * Ровно то, что делал бы человек в мастере: создаёт сессию от товара,
 * прикладывает разбор референса из библиотеки, просит промпт,
 * утверждает его и запускает генерацию. Единственная точка входа в
 * генерацию — `GenerationService.generateVideo`, и это важно: внутри
 * неё живут проверки прав, блокировки, потолок расхода и резерв
 * кредитов. Обойти её (как делает ветка Grok-батча у соседа) значит
 * переписать всё это заново.
 *
 * ## Почему шаги проверяются по СОСТОЯНИЮ сессии, а не по статусу строки
 *
 * Тик может оборваться посередине — таймаут функции, деплой, что
 * угодно. Статус строки говорит «начали», но не говорит, на чём именно
 * остановились; сессия говорит. Поэтому повторный заход смотрит, есть
 * ли утверждённый промпт и начатый рендер, и доделывает недостающее, а
 * не платит второй раз за сделанное.
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SessionService } from '../../common/session.service';
import { ProjectSessionService } from '../project-session/project-session.service';
import { LibraryService } from '../library/library.service';
import { PromptService } from '../prompt/prompt.service';
import { GenerationService } from '../generation/generation.service';
import { tryAcquireJobLock, releaseJobLock } from '../../common/cron-job-lock';
import {
  DailySpendLimitExceededException,
  startOfDayUtc,
} from '../../common/spend-limits';
import { MAX_ATTEMPTS, nextAttemptAt } from '../../common/api-video-job';
import { ApiWebhookService } from './api-webhook.service';
import type { VideoQuality } from '../../common/types/generation.types';

const JOB_KEY = 'api-video-run';
/** Столько строк за тик: заявок единицы, а генерация небыстрая. */
const BATCH = 3;
/** Замок строки: тик не должен подхватить то, что уже в работе. */
const LOCK_MS = 10 * 60 * 1000;

/**
 * Отказы, которые повтором не лечатся: чужой id, отозванное право,
 * негодное тело. Повторять их — это платить за один и тот же ответ.
 */
const NON_RETRYABLE = new Set([
  'ForbiddenException',
  'NotFoundException',
  'BadRequestException',
]);

interface JobRow {
  id: string;
  userId: string;
  apiKeyId: string;
  projectId: string;
  productItemId: string;
  libraryEntryId: string;
  quality: string;
  aspectRatio: string | null;
  locale: string | null;
  sessionId: string | null;
  attempts: number;
}

export interface ApiVideoTickResult {
  started: number;
  completed: number;
  failed: number;
  running: number;
  /** Доставки исходов (этап 146) — тем же тиком: их единицы. */
  delivered: number;
  retried: number;
  gaveUp: number;
}

@Injectable()
export class ApiVideoJobWorker {
  private readonly logger = new Logger(ApiVideoJobWorker.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly projectSession: ProjectSessionService,
    private readonly library: LibraryService,
    private readonly prompt: PromptService,
    private readonly generation: GenerationService,
    private readonly webhooks: ApiWebhookService,
  ) {}

  async runTick(): Promise<ApiVideoTickResult> {
    // Замок на весь джоб: два тика подряд платили бы за одну заявку
    // дважды в окне, где строка ещё не помечена.
    const lock = await tryAcquireJobLock(this.prisma, JOB_KEY);
    if (!lock) {
      return {
        started: 0,
        completed: 0,
        failed: 0,
        running: 0,
        delivered: 0,
        retried: 0,
        gaveUp: 0,
      };
    }
    try {
      return await this.tick();
    } finally {
      await releaseJobLock(this.prisma, JOB_KEY);
    }
  }

  private async tick(): Promise<ApiVideoTickResult> {
    const result: ApiVideoTickResult = {
      started: 0,
      completed: 0,
      failed: 0,
      running: 0,
      delivered: 0,
      retried: 0,
      gaveUp: 0,
    };

    // 1. Двигаем то, что уже рендерится. Тем же вызовом, что и мастер:
    //    он и опрашивает провайдера, и запускает постобработку.
    const running = (await this.prisma.apiVideoJob.findMany({
      where: { status: 'RUNNING', sessionId: { not: null } },
      take: BATCH,
    })) as JobRow[];
    for (const row of running) {
      try {
        const done = await this.advance(row);
        if (done) result.completed++;
        else result.running++;
      } catch (e) {
        await this.fail(row, e);
        result.failed++;
      }
    }

    // 2. Берём новое: новые заявки и те, чей срок повтора наступил.
    const queued = (await this.prisma.apiVideoJob.findMany({
      where: {
        OR: [
          { status: 'QUEUED' },
          { status: 'FAILED', nextAttemptAt: { lte: new Date() } },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: BATCH,
    })) as JobRow[];

    for (const row of queued) {
      // Захват ДО любого платного вызова: без него параллельный тик
      // (или ручной запуск из админки) оплатил бы ту же заявку второй
      // раз.
      const claim = await this.prisma.apiVideoJob.updateMany({
        where: {
          id: row.id,
          OR: [{ lockedUntil: null }, { lockedUntil: { lt: new Date() } }],
        },
        data: { lockedUntil: new Date(Date.now() + LOCK_MS) },
      });
      if (claim.count === 0) continue;

      try {
        await this.start(row);
        result.started++;
      } catch (e) {
        await this.fail(row, e);
        result.failed++;
      }
    }

    // 3. Разослать исходы. Тем же тиком, а не своим кроном: доставок
    //    столько же, сколько закончившихся заявок, то есть единицы, а
    //    отдельный слот у Vercel не бесплатный.
    Object.assign(result, await this.webhooks.deliverDue());
    return result;
  }

  /** Довести рендер. `true` — заявка закрыта. */
  private async advance(row: JobRow): Promise<boolean> {
    const status = await this.generation.getVideoStatus(
      row.sessionId as string,
    );
    if (status.status === 'complete' && status.postStatus !== 'pending') {
      await this.prisma.apiVideoJob.update({
        where: { id: row.id },
        data: {
          status: 'DONE',
          videoUrl: status.downloadUrl ?? null,
          lockedUntil: null,
          error: null,
        },
      });
      await this.webhooks.enqueue(row.userId, row.id, row.apiKeyId);
      return true;
    }
    if (status.status === 'failed') {
      // Причина от провайдера — строкой: у чужого кода в поле `error`
      // должен быть текст, а не наш объект с полями.
      await this.fail(
        row,
        new Error(status.error?.message ?? 'генерация не удалась'),
      );
      return true;
    }
    return false;
  }

  /** Пройти путь мастера и запустить генерацию. */
  private async start(row: JobRow): Promise<void> {
    const sessionId =
      row.sessionId ??
      (
        await this.projectSession.createFromItem(
          row.userId,
          row.projectId,
          row.productItemId,
          row.locale ?? undefined,
        )
      ).sessionId;
    if (!row.sessionId) {
      await this.prisma.apiVideoJob.update({
        where: { id: row.id },
        data: { sessionId },
      });
    }

    // Что уже сделано — видно по сессии, а не по статусу строки: тик
    // мог оборваться посередине.
    const session = await this.sessions.getSession(sessionId);
    const promptApproved = Boolean(session?.generationPrompt?.approvedAt);
    const videoStarted = Boolean(session?.generatedVideo);

    if (!promptApproved && !videoStarted) {
      await this.library.applyToSession(sessionId, row.libraryEntryId);
      await this.prompt.generatePrompt(sessionId);
      await this.prompt.approvePrompt(sessionId);
    }

    if (!videoStarted) {
      await this.generation.generateVideo(
        sessionId,
        row.quality as VideoQuality,
        row.aspectRatio ?? undefined,
      );
    }

    await this.prisma.apiVideoJob.update({
      where: { id: row.id },
      data: { status: 'RUNNING', lockedUntil: null, error: null },
    });
  }

  /**
   * Записать отказ и решить, будет ли повтор.
   *
   * Те же три правила, что у пакетной генерации. Отдельно — суточный
   * потолок: он не «сломалось», а «на сегодня хватит», попытку за него
   * не засчитываем и возвращаемся после полуночи. Иначе три ночных
   * заявки сгорели бы, не начавшись.
   */
  private async fail(row: JobRow, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const name = error instanceof Error ? error.constructor.name : '';
    const daily = error instanceof DailySpendLimitExceededException;
    const attempts = daily ? row.attempts : row.attempts + 1;
    const exhausted =
      !daily && (NON_RETRYABLE.has(name) || attempts >= MAX_ATTEMPTS);

    this.logger.warn(`заявка ${row.id}: ${message}`);
    await this.prisma.apiVideoJob.update({
      where: { id: row.id },
      data: {
        status: 'FAILED',
        attempts,
        error: message.slice(0, 2000),
        // FAILED и у неисчерпанной заявки тоже, как у соседних
        // воркеров: строку с ненаступившим сроком тик просто не
        // выбирает, а `nextAttemptAt: null` не выберет уже никогда.
        nextAttemptAt: exhausted
          ? null
          : daily
            ? new Date(
                startOfDayUtc(new Date()).getTime() + 24 * 60 * 60 * 1000,
              )
            : nextAttemptAt(attempts, new Date()),
        lockedUntil: null,
      },
    });
    // Сообщаем только о КОНЧИВШЕЙСЯ заявке: «не вышло, попробуем через
    // четыре минуты» — это наша кухня, и слать её чужому приёмнику
    // значит приучить его игнорировать наши сообщения.
    if (exhausted) {
      await this.webhooks.enqueue(row.userId, row.id, row.apiKeyId);
    }
  }
}
