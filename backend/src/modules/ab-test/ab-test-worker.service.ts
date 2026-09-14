/**
 * AbTestWorkerService — крон-воркер A/B-вариантов одного ролика (TODO
 * §III.6, этап 66). Вызывается `GET /api/cron/ab-test-run` каждые 1-2
 * минуты (`backend/vercel.json`).
 *
 * Один прогон (`runBatch`) берёт до `abTest.cronBatch` строк
 * `AbTestVariant`, готовых к попытке (PENDING или FAILED с истёкшим
 * nextAttemptAt), и обрабатывает их по одной — тот же claim/бэкофф
 * почерк, что у `CatalogBatchWorkerService` (этап 65).
 *
 * ## Отличие от CatalogBatchWorkerService: текст промпта уже готов
 *
 * У пакетной генерации по каталогу каждая строка требует своего вызова
 * GPT-5 (товар разный). Здесь товар и стиль ОДИН и тот же — весь набор
 * текстов уже получен ОДНИМ вызовом `PromptService.generateAbVariants`
 * при создании запуска (`AbTestService.create`) и лежит на самой строке
 * (`promptText`/`voiceoverScript`). Воркеру остаётся: создать дочернюю
 * сессию (если ещё нет) → перенести разбор → ПОСЕЯТЬ уже готовый текст
 * (`PromptService.seedPrompt`, без GPT-5) → одобрить → стартовать рендер.
 *
 * ## Досмотр рендера (пятый аудит, Д-1.1)
 *
 * Тот же дефект и та же правка, что у `CatalogBatchWorkerService` (её
 * доккомментарий разбирает подробно — не повторяется здесь): воркер
 * стартовал рендер и никогда не возвращался к строке, оплаченный ролик
 * был структурно недостижим, если никто не держал экран прогресса
 * открытым. Теперь `runBatch()` сначала досматривает уже стартовавшие
 * `GENERATING`-строки через `GenerationService.getVideoStatus()`.
 *
 * ## Джоб-уровневый замок (пятый аудит, Д-3.3)
 *
 * Тот же приём и то же обоснование, что у `CatalogBatchWorkerService`
 * (см. её доккомментарий) — построчный claim не мешает двум параллельным
 * `runBatch()` обработать разные строки одного и того же запуска
 * одновременно и вместе проскочить дневной лимит. `runBatch()` целиком
 * оборачивается джоб-уровневым замком (`common/cron-job-lock.ts`).
 */

import { Injectable, Logger } from '@nestjs/common';
import { WorkflowKind } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { loadConfiguration } from '../../config/configuration';
import {
  GenerationStatus,
  VideoQuality,
} from '../../common/types/generation.types';
import { ProjectSessionService } from '../project-session/project-session.service';
import { SessionService } from '../../common/session.service';
import { LibraryService } from '../library/library.service';
import { PromptService } from '../prompt/prompt.service';
import { GenerationService } from '../generation/generation.service';
import { tryAcquireJobLock, releaseJobLock } from '../../common/cron-job-lock';
import { logWorkflowStage } from '../../common/workflow-stage-events';
import {
  DailySpendLimitExceededException,
  startOfDayUtc,
} from '../../common/spend-limits';

/** Claim держим не дольше самой долгой реалистичной обработки одного
 * варианта (перенос разбора + старт Veo) с большим запасом. */
const LOCK_MS = 10 * 60 * 1000;

/** Ключ джоба для джоб-уровневого замка (Д-3.3) — совпадает с
 * `jobKey`, под которым этот джоб пишется в `CronRunLog`. */
const JOB_KEY = 'ab-test-run';

interface ClaimableRow {
  id: string;
  runId: string;
  variantIndex: number;
  promptText: string;
  voiceoverScript: string | null;
  sessionId: string | null;
  attempts: number;
  /** Статус строки на момент выборки этим тиком — fromStage для события
   * воронки (этап 78), тот же приём, что у `CatalogBatchWorkerService`. */
  status: string;
}

interface RunRow {
  id: string;
  userId: string;
  projectId: string;
  productItemId: string;
  libraryEntryId: string;
  quality: string;
  aspectRatio: string | null;
  locale: string | null;
}

export interface AbTestRunResult {
  processed: number;
  started: number;
  failed: number;
  stillPending: number;
  /** Досмотр уже рендерящихся строк этим тиком (Д-1.1) — сколько
   * проверено, сколько дорендерилось, сколько провалилось у Veo. */
  renderChecked: number;
  renderCompleted: number;
  renderFailed: number;
}

/** Отказ по правилам сервиса (план понижен, пользователь заблокирован,
 * разбор/товар пропал) — не временный сбой, ретраить бессмысленно, сразу
 * FAILED. Тот же список, что у CatalogBatchWorkerService — как и там,
 * суточный лимит расхода (Е-1.2 шестого аудита) сюда сознательно не
 * входит: он бросает отдельный `DailySpendLimitExceededException`,
 * обрабатываемый отдельно в `recordFailure()` (временное состояние, не
 * навсегда).
 *
 * Е-1.4 шестого аудита (этап 77): `VeoOperationOrphanedError` — тот же
 * повод, что у CatalogBatchWorkerService — Veo уже реально стартовала
 * (деньги потрачены), обычный ретрай оплатил бы ещё один рендер того же
 * варианта поверх уже идущего первого. */
const NON_RETRYABLE_NAMES = new Set([
  'ForbiddenException',
  'NotFoundException',
  'BadRequestException',
  'VeoOperationOrphanedError',
]);

@Injectable()
export class AbTestWorkerService {
  private readonly logger = new Logger(AbTestWorkerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly projectSession: ProjectSessionService,
    private readonly sessions: SessionService,
    private readonly library: LibraryService,
    private readonly prompt: PromptService,
    private readonly generation: GenerationService,
  ) {}

  private cfg() {
    return loadConfiguration().abTest;
  }

  async runBatch(): Promise<AbTestRunResult> {
    // Джоб-уровневый замок (Д-3.3) — ДО любого чтения/записи ниже. Если
    // другой прогон этого же джоба уже идёт, тихо пропускаем тик.
    const acquired = await tryAcquireJobLock(this.prisma, JOB_KEY);
    if (!acquired) {
      this.logger.warn(
        `Крон A/B-вариантов: пропуск тика — другой прогон этого же джоба ещё выполняется`,
      );
      return {
        processed: 0,
        started: 0,
        failed: 0,
        stillPending: 0,
        renderChecked: 0,
        renderCompleted: 0,
        renderFailed: 0,
      };
    }
    try {
      return await this.runBatchLocked();
    } finally {
      await releaseJobLock(this.prisma, JOB_KEY);
    }
  }

  private async runBatchLocked(): Promise<AbTestRunResult> {
    // Досмотр уже стартовавших рендеров — ДО выборки новых строк, тот
    // же порядок, что у CatalogBatchWorkerService (см. доккомментарий
    // класса, Д-1.1).
    const advanced = await this.advanceGenerating();

    const rows: ClaimableRow[] = await this.prisma.abTestVariant.findMany({
      where: {
        OR: [
          { status: 'PENDING' },
          {
            status: 'FAILED',
            nextAttemptAt: { lte: new Date() },
          },
        ],
      },
      select: {
        id: true,
        runId: true,
        variantIndex: true,
        promptText: true,
        voiceoverScript: true,
        sessionId: true,
        attempts: true,
        status: true,
      },
      orderBy: { createdAt: 'asc' },
      take: this.cfg().cronBatch,
    });

    let started = 0;
    let failed = 0;
    const runCache = new Map<string, RunRow>();

    for (const row of rows) {
      // Claim, ДО любого сетевого/платного вызова.
      const claim = await this.prisma.abTestVariant.updateMany({
        where: {
          id: row.id,
          OR: [{ lockedUntil: null }, { lockedUntil: { lt: new Date() } }],
        },
        data: { lockedUntil: new Date(Date.now() + LOCK_MS) },
      });
      if (claim.count === 0) continue;

      try {
        const run = await this.getRunCached(row.runId, runCache);
        await this.processOne(row, run);
        started += 1;
      } catch (error) {
        failed += 1;
        await this.recordFailure(row, error);
      }
    }

    const result: AbTestRunResult = {
      processed: rows.length,
      started,
      failed,
      stillPending: rows.length - started - failed,
      renderChecked: advanced.checked,
      renderCompleted: advanced.completed,
      renderFailed: advanced.renderFailed,
    };
    if (rows.length > 0 || advanced.checked > 0) {
      this.logger.log(
        `Крон A/B-вариантов: обработано ${result.processed}, стартовало ${result.started}, ` +
          `ошибок ${result.failed}, в очереди ${result.stillPending}; досмотр рендера: ` +
          `проверено ${result.renderChecked}, готово ${result.renderCompleted}, ` +
          `провалилось ${result.renderFailed}`,
      );
    }
    return result;
  }

  /**
   * Досматривает уже стартовавшие `GENERATING`-строки — тот же приём,
   * что `CatalogBatchWorkerService.advanceGenerating()` (см. её
   * доккомментарий); варианты A/B и товары партии — разные модели, но
   * логика продвижения статуса рендера идентична.
   */
  private async advanceGenerating(): Promise<{
    checked: number;
    completed: number;
    renderFailed: number;
  }> {
    const rows = await this.prisma.abTestVariant.findMany({
      where: { status: 'GENERATING', sessionId: { not: null } },
      select: { id: true, runId: true, variantIndex: true, sessionId: true },
      orderBy: { createdAt: 'asc' },
      take: this.cfg().cronBatch,
    });

    let completed = 0;
    let renderFailed = 0;
    for (const row of rows) {
      const claim = await this.prisma.abTestVariant.updateMany({
        where: {
          id: row.id,
          OR: [{ lockedUntil: null }, { lockedUntil: { lt: new Date() } }],
        },
        data: { lockedUntil: new Date(Date.now() + LOCK_MS) },
      });
      if (claim.count === 0) continue;

      try {
        const video = await this.generation.getVideoStatus(row.sessionId!);
        if (
          video.status === GenerationStatus.COMPLETE &&
          video.postStatus !== 'pending'
        ) {
          await this.prisma.abTestVariant.update({
            where: { id: row.id },
            data: { status: 'DONE', lockedUntil: null },
          });
          await logWorkflowStage(
            this.prisma,
            WorkflowKind.AB_TEST_VARIANT,
            row.id,
            'GENERATING',
            'DONE',
          );
          completed += 1;
        } else if (video.status === GenerationStatus.FAILED) {
          await this.prisma.abTestVariant.update({
            where: { id: row.id },
            data: {
              status: 'FAILED',
              error: video.error?.message ?? 'Рендер не удался',
              lockedUntil: null,
            },
          });
          await logWorkflowStage(
            this.prisma,
            WorkflowKind.AB_TEST_VARIANT,
            row.id,
            'GENERATING',
            'FAILED',
          );
          renderFailed += 1;
        } else {
          await this.prisma.abTestVariant
            .update({ where: { id: row.id }, data: { lockedUntil: null } })
            .catch(() => undefined);
        }
      } catch (error) {
        this.logger.warn(
          `Проверка статуса рендера (запуск ${row.runId}, вариант ${row.variantIndex}) не удалась: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
        await this.prisma.abTestVariant
          .update({ where: { id: row.id }, data: { lockedUntil: null } })
          .catch(() => undefined);
      }
    }
    return { checked: rows.length, completed, renderFailed };
  }

  /** Снимок запуска — с кэшем на один прогон `runBatch` (несколько
   * вариантов одного запуска не должны читать `AbTestRun` по многу раз).
   * Явная сигнатура `Promise<RunRow>` — тот же приём, что у
   * `CatalogBatchWorkerService.getBatchCached` (см. её комментарий про
   * `any`-сужение без сгенерированного Prisma-клиента). */
  private async getRunCached(
    runId: string,
    cache: Map<string, RunRow>,
  ): Promise<RunRow> {
    const cached = cache.get(runId);
    if (cached) return cached;
    const found = await this.prisma.abTestRun.findUnique({
      where: { id: runId },
    });
    if (!found) {
      throw Object.assign(new Error(`AbTestRun ${runId} not found`), {
        name: 'NotFoundException',
      });
    }
    const run: RunRow = found;
    cache.set(runId, run);
    return run;
  }

  /** Четыре шага на один вариант, без остановки между ними — текст уже
   * готов (посеян, не сгенерирован здесь), см. комментарий класса выше.
   * Резюмируемо по реальному состоянию сессии — тот же приём и та же
   * причина (Д-2.5, пятый аудит), что у
   * `CatalogBatchWorkerService.processOne` (см. её подробный
   * комментарий): `seedPrompt`/`approvePrompt` здесь бесплатны (текст
   * уже оплачен один раз при создании запуска), но повторный вызов
   * `generateVideo()` на уже стартовавшей сессии всё равно упёрся бы в
   * её же замок и держал бы строку в FAILED без выхода. */
  private async processOne(row: ClaimableRow, run: RunRow): Promise<void> {
    let sessionId = row.sessionId;
    if (!sessionId) {
      const session = await this.projectSession.createFromItem(
        run.userId,
        run.projectId,
        run.productItemId,
        run.locale ?? undefined,
      );
      sessionId = session.sessionId;
      await this.prisma.abTestVariant.update({
        where: { id: row.id },
        data: { sessionId },
      });
    }

    const current = await this.sessions.getSession(sessionId);
    const promptApproved = Boolean(current?.generationPrompt?.approvedAt);
    const videoStarted = Boolean(current?.generatedVideo);

    if (!promptApproved && !videoStarted) {
      await this.library.applyToSession(sessionId, run.libraryEntryId);
      await this.prompt.seedPrompt(
        sessionId,
        row.promptText,
        row.voiceoverScript,
      );
      await this.prompt.approvePrompt(sessionId);
    }
    if (!videoStarted) {
      // Явно 'veo' — не полагаться на дефолт параметра: A/B-тестирование
      // никогда не расширялось под Grok (нет provider-поля в его схеме,
      // см. аудит §16.4) — если дефолт когда-нибудь поменяют для
      // пользовательского мастера (ТЗ §20, «максимальный профит»), этот
      // вызов не должен тихо потянуться следом туда, где это не
      // проверялось вовсе.
      await this.generation.generateVideo(
        sessionId,
        run.quality as VideoQuality,
        run.aspectRatio ?? undefined,
        'veo',
      );
    }

    await this.prisma.abTestVariant.update({
      where: { id: row.id },
      data: { status: 'GENERATING', lockedUntil: null, error: null },
    });
    await logWorkflowStage(
      this.prisma,
      WorkflowKind.AB_TEST_VARIANT,
      row.id,
      row.status,
      'GENERATING',
    );
  }

  /** Бэкофф — attempts++, nextAttemptAt = now + 2^attempts мин, тот же
   * приём и та же формула, что у CatalogBatchWorkerService. Не
   * retryable-ошибка — сразу FAILED, без пустых повторов.
   *
   * Е-1.2 шестого аудита: суточный лимит расхода — особый случай, см.
   * подробный комментарий у `CatalogBatchWorkerService.recordFailure()`
   * (тот же приём: `nextAttemptAt` — начало следующих суток UTC,
   * `exhausted` для него не считается вовсе). */
  private async recordFailure(
    row: ClaimableRow,
    error: unknown,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const errorName =
      error instanceof Error ? error.constructor.name : undefined;
    const attempts = row.attempts + 1;
    const maxAttempts = this.cfg().maxAttempts;
    const isDailyLimit = error instanceof DailySpendLimitExceededException;
    const nonRetryable =
      !isDailyLimit && errorName ? NON_RETRYABLE_NAMES.has(errorName) : false;
    const exhausted =
      !isDailyLimit && (nonRetryable || attempts >= maxAttempts);
    const nextAttemptAt = exhausted
      ? null
      : isDailyLimit
        ? new Date(startOfDayUtc(new Date()).getTime() + 24 * 60 * 60 * 1000)
        : new Date(Date.now() + 2 ** attempts * 60_000);
    await this.prisma.abTestVariant.update({
      where: { id: row.id },
      data: {
        attempts,
        error: message.slice(0, 2000),
        status: 'FAILED',
        nextAttemptAt,
        lockedUntil: null,
      },
    });
    await logWorkflowStage(
      this.prisma,
      WorkflowKind.AB_TEST_VARIANT,
      row.id,
      row.status,
      'FAILED',
    );
    this.logger.warn(
      `Вариант ${row.variantIndex} (запуск ${row.runId}): попытка ${attempts}/${maxAttempts} не удалась — ${message}` +
        (isDailyLimit
          ? ', суточный лимит расхода — повтор завтра'
          : exhausted
            ? ', дальше не повторяем → FAILED'
            : ''),
    );
  }
}
