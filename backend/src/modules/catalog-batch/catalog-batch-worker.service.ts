/**
 * CatalogBatchWorkerService — крон-воркер пакетной генерации по каталогу
 * (ТЗ §44, этап 65). Вызывается `GET /api/cron/catalog-batch-run` каждые
 * 1-2 минуты (`backend/vercel.json`).
 *
 * Один прогон (`runBatch`) берёт до `catalogBatch.cronBatch` строк
 * `CatalogBatchItem`, готовых к попытке (PENDING или FAILED с истёкшим
 * nextAttemptAt), и обрабатывает их по одной — тот же почерк, что у
 * `PublishWorkerService`/`MarketingBroadcastService`: один битый товар
 * не блокирует остальные.
 *
 * ## Claim перед обработкой (тот же приём, что закрыл Г-2.11)
 *
 * Атомарный `updateMany` перед любым внешним вызовом — строку, которую
 * уже держит другой тик (два тика крона перекрываются на партии из
 * многих товаров), просто пропускаем.
 *
 * ## Один тик = один товар: сессия → разбор → промпт → одобрение →
 * старт рендера
 *
 * Пять шагов на строку, без остановки между ними (решение владельца
 * продукта: промпт для остальных товаров одобряется автоматически, а
 * не по одному). Сам рендер (готово/провал) — асинхронный, как и
 * всегда.
 *
 * ## Досмотр рендера (пятый аудит, Д-1.1)
 *
 * До этой правки воркер стартовал рендер и никогда не возвращался к
 * строке — состояние «дочитывалось» только пассивно, внутри
 * `CatalogBatchService.getStatus()`, и только пока кто-то держал экран
 * прогресса открытым. Если оператор уходил после клика «Сделать так же
 * для линейки», оплаченный ролик был физически готов у Veo, но статус
 * строки навсегда оставался `GENERATING` — интерфейс не мог до него
 * добраться (см. doc/AUDIT-2026-09-09-round5.md, Д-1.1).
 *
 * Теперь КАЖДЫЙ тик `runBatch()` сначала досматривает уже стартовавшие
 * `GENERATING`-строки (`advanceGenerating()`) — вызывает тот же
 * `GenerationService.getVideoStatus()`, что и мастер-сценарий, который
 * реально опрашивает Veo, продвигает статус и запускает постобработку.
 * Так же бесплатно чинится 20-минутный дедлайн зависшего рендера
 * (В-2.8) — он живёт внутри `getVideoStatus()` и теперь тоже
 * срабатывает для партий, не только для мастера.
 *
 * ## Джоб-уровневый замок (пятый аудит, Д-3.3)
 *
 * Построчный claim (`lockedUntil` выше) не мешает ДВУМ параллельным
 * `runBatch()` обработать РАЗНЫЕ строки одной и той же партии
 * одновременно — каждый пройдёт свою проверку дневного лимита раньше,
 * чем другой запишет расход. `runBatch()` целиком оборачивается
 * джоб-уровневым замком (`common/cron-job-lock.ts`, там же — почему не
 * advisory-лок) — второй параллельный вызов просто пропускает тик.
 */

import { Injectable, Logger } from '@nestjs/common';
import { WorkflowKind } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { loadConfiguration } from '../../config/configuration';
import {
  GenerationStatus,
  VideoQuality,
  GeneratedVideo,
} from '../../common/types/generation.types';
import { ProjectSessionService } from '../project-session/project-session.service';
import { SessionService } from '../../common/session.service';
import { LibraryService } from '../library/library.service';
import { PromptService } from '../prompt/prompt.service';
import { GenerationService } from '../generation/generation.service';
import { GrokVideoBatchService } from '../generation/grok-video-batch.service';
import { GrokResolution } from '../generation/grok-video.service';
import { PlanService } from '../plan/plan.service';
import { AiUsageService } from '../ai-usage/ai-usage.service';
import { estimateCost } from '../../common/ai-pricing';
import { BlobService } from '../storage/blob.service';
import { SessionStatus } from '../../common/types/session.types';
import { v4 as uuidv4 } from 'uuid';
import { VIDEO_DURATION_SECONDS } from '../../common/veo-duration';
import { tryAcquireJobLock, releaseJobLock } from '../../common/cron-job-lock';
import { logWorkflowStage } from '../../common/workflow-stage-events';
import {
  DailySpendLimitExceededException,
  startOfDayUtc,
} from '../../common/spend-limits';

/** Claim держим не дольше самой долгой реалистичной обработки одного
 * товара (разбор + два вызова GPT-5/Veo) с большим запасом. */
const LOCK_MS = 10 * 60 * 1000;

/** Ключ джоба для джоб-уровневого замка (Д-3.3) — совпадает с
 * `jobKey`, под которым этот джоб пишется в `CronRunLog`. */
const JOB_KEY = 'catalog-batch-run';

interface ClaimableRow {
  id: string;
  batchId: string;
  productItemId: string;
  sessionId: string | null;
  attempts: number;
  /** Статус строки НА МОМЕНТ выборки этим тиком — нужен как fromStage
   * для события воронки (этап 78, doc/WORKFLOW-FUNNEL-SPEC.md §3.2):
   * `findMany` ниже выбирает и PENDING, и просроченный FAILED одним
   * запросом, поэтому конкретное значение узнаём только через select. */
  status: string;
}

interface BatchRow {
  id: string;
  projectId: string;
  userId: string;
  libraryEntryId: string;
  quality: string;
  aspectRatio: string | null;
  locale: string | null;
  /** Доп. запрос владельца продукта (ТЗ §13, этап 2 плана §14). */
  provider: string;
  resolution: string | null;
  xaiBatchId: string | null;
}

export interface CatalogBatchRunResult {
  processed: number;
  started: number;
  failed: number;
  stillPending: number;
  /** Досмотр уже рендерящихся строк этим тиком (Д-1.1) — сколько
   * проверено, сколько дорендерилось, сколько провалилось у Veo. */
  renderChecked: number;
  renderCompleted: number;
  renderFailed: number;
  /** Доп. запрос владельца продукта (ТЗ §13, этап 2 плана §14) — то
   * же самое, что renderChecked/renderCompleted/renderFailed выше, но
   * для строк, ушедших через xAI Batch API, не синхронный путь. */
  grokBatchesSubmitted: number;
  grokBatchItemsCompleted: number;
  grokBatchItemsFailed: number;
}

/** Отказ по правилам сервиса (план понижен, пользователь заблокирован,
 * товар пропал) — не временный сбой, ретраить бессмысленно, сразу FAILED.
 * Отличается от сетевых/таймаутных ошибок, для которых нужен обычный
 * бэкофф.
 *
 * Е-1.2 шестого аудита (этап 76): суточный лимит расхода тоже бросает
 * `ForbiddenException` по HTTP-статусу, но это ВРЕМЕННОЕ состояние
 * (сбрасывается на следующие сутки) — теперь он бросает отдельный класс
 * `DailySpendLimitExceededException` (не входящий в этот набор) и
 * обрабатывается отдельно в `recordFailure()`, а не как «навсегда».
 *
 * Е-1.4 шестого аудита (этап 77): `VeoOperationOrphanedError` — Veo уже
 * реально стартовала (деньги потрачены), но записать результат не
 * удалось. Обычный ретрай этой строки запустил бы ВТОРОЙ настоящий
 * платный рендер того же товара поверх уже идущего первого — здесь
 * нужен ручной разбор оператором, не автоматический повтор. */
const NON_RETRYABLE_NAMES = new Set([
  'ForbiddenException',
  'NotFoundException',
  'BadRequestException',
  'VeoOperationOrphanedError',
]);

@Injectable()
export class CatalogBatchWorkerService {
  private readonly logger = new Logger(CatalogBatchWorkerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly projectSession: ProjectSessionService,
    private readonly sessions: SessionService,
    private readonly library: LibraryService,
    private readonly prompt: PromptService,
    private readonly generation: GenerationService,
    private readonly grokBatch: GrokVideoBatchService,
    private readonly blob: BlobService,
    // Найдено при аудите (ТЗ §13, этап 2 плана §14): Grok-путь этого
    // воркера вызывает `GrokVideoBatchService` НАПРЯМУЮ, минуя
    // `GenerationService.generateVideo()` — а именно там живут проверка
    // дневного бюджета и запись фактического расхода для ВСЕХ ОСТАЛЬНЫХ
    // путей генерации в проекте. Без этих двух сервисов здесь Grok-
    // партии по каталогу могли запускаться без единой проверки бюджета
    // и НИКОГДА не попадали в отчёт о расходах — реальные деньги,
    // потраченные у xAI, были бы невидимы для всей системы учёта.
    private readonly plans: PlanService,
    private readonly aiUsage: AiUsageService,
  ) {}

  private cfg() {
    return loadConfiguration().catalogBatch;
  }

  async runBatch(): Promise<CatalogBatchRunResult> {
    // Джоб-уровневый замок (Д-3.3) — ДО любого чтения/записи ниже. Если
    // другой прогон этого же джоба уже идёт (двойной клик оператора или
    // совпадение с расписанием Vercel Cron), тихо пропускаем тик, а не
    // соревнуемся с ним построчно.
    const acquired = await tryAcquireJobLock(this.prisma, JOB_KEY);
    if (!acquired) {
      this.logger.warn(
        `Крон партийной генерации: пропуск тика — другой прогон этого же джоба ещё выполняется`,
      );
      return {
        processed: 0,
        started: 0,
        failed: 0,
        stillPending: 0,
        renderChecked: 0,
        renderCompleted: 0,
        renderFailed: 0,
        grokBatchesSubmitted: 0,
        grokBatchItemsCompleted: 0,
        grokBatchItemsFailed: 0,
      };
    }
    try {
      return await this.runBatchLocked();
    } finally {
      await releaseJobLock(this.prisma, JOB_KEY);
    }
  }

  private async runBatchLocked(): Promise<CatalogBatchRunResult> {
    // Досмотр уже стартовавших рендеров — ДО выборки новых строк, чтобы
    // не опрашивать сессию, которую этот же тик только что запустил
    // (см. доккомментарий класса, Д-1.1).
    const advanced = await this.advanceGenerating();

    const rows: ClaimableRow[] = await this.prisma.catalogBatchItem.findMany({
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
        batchId: true,
        productItemId: true,
        sessionId: true,
        attempts: true,
        status: true,
      },
      orderBy: { createdAt: 'asc' },
      take: this.cfg().cronBatch,
    });

    let started = 0;
    let failed = 0;
    const batchCache = new Map<string, BatchRow>();

    for (const row of rows) {
      // Claim, ДО любого сетевого/платного вызова.
      const claim = await this.prisma.catalogBatchItem.updateMany({
        where: {
          id: row.id,
          OR: [{ lockedUntil: null }, { lockedUntil: { lt: new Date() } }],
        },
        data: { lockedUntil: new Date(Date.now() + LOCK_MS) },
      });
      if (claim.count === 0) continue;

      try {
        const batch = await this.getBatchCached(row.batchId, batchCache);
        await this.processOne(row, batch);
        started += 1;
      } catch (error) {
        failed += 1;
        await this.recordFailure(row, error);
      }
    }

    // Доп. запрос владельца продукта (ТЗ §13, этап 2 плана §14): та же
    // идея, что у `advanceGenerating()` выше — идёт после обработки
    // новых строк тика, чтобы строки, только что поставленные в очередь
    // этим же тиком, тоже подхватились подачей пачки, если она наберётся.
    const grokBatches = await this.advanceGrokBatches();

    const result: CatalogBatchRunResult = {
      processed: rows.length,
      started,
      failed,
      stillPending: rows.length - started - failed,
      renderChecked: advanced.checked,
      renderCompleted: advanced.completed,
      renderFailed: advanced.renderFailed,
      grokBatchesSubmitted: grokBatches.submitted,
      grokBatchItemsCompleted: grokBatches.completed,
      grokBatchItemsFailed: grokBatches.failed,
    };
    if (
      rows.length > 0 ||
      advanced.checked > 0 ||
      grokBatches.submitted > 0 ||
      grokBatches.completed > 0 ||
      grokBatches.failed > 0
    ) {
      this.logger.log(
        `Крон партийной генерации: обработано ${result.processed}, стартовало ${result.started}, ` +
          `ошибок ${result.failed}, в очереди ${result.stillPending}; досмотр рендера: ` +
          `проверено ${result.renderChecked}, готово ${result.renderCompleted}, ` +
          `провалилось ${result.renderFailed}; Grok-пачки: подано ${result.grokBatchesSubmitted}, ` +
          `готово строк ${result.grokBatchItemsCompleted}, провалилось строк ${result.grokBatchItemsFailed}`,
      );
    }
    return result;
  }

  /**
   * Досматривает уже стартовавшие `GENERATING`-строки — вызывает
   * `GenerationService.getVideoStatus()` (тот же путь, что и опрос из
   * мастера) для каждой, продвигает статус строки по факту рендера.
   * Без этого метода партия структурно не могла завершиться, если никто
   * не держал экран прогресса открытым (Д-1.1, пятый аудит).
   */
  private async advanceGenerating(): Promise<{
    checked: number;
    completed: number;
    renderFailed: number;
  }> {
    const rows = await this.prisma.catalogBatchItem.findMany({
      where: { status: 'GENERATING', sessionId: { not: null } },
      select: {
        id: true,
        batchId: true,
        productItemId: true,
        sessionId: true,
      },
      orderBy: { createdAt: 'asc' },
      take: this.cfg().cronBatch,
    });

    let completed = 0;
    let renderFailed = 0;
    for (const row of rows) {
      // Тот же claim, что у новых строк — два перекрывающихся тика не
      // должны опрашивать Veo по одной и той же сессии параллельно.
      const claim = await this.prisma.catalogBatchItem.updateMany({
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
          await this.prisma.catalogBatchItem.update({
            where: { id: row.id },
            data: { status: 'DONE', lockedUntil: null },
          });
          await logWorkflowStage(
            this.prisma,
            WorkflowKind.CATALOG_BATCH_ITEM,
            row.id,
            'GENERATING',
            'DONE',
          );
          completed += 1;
        } else if (video.status === GenerationStatus.FAILED) {
          await this.prisma.catalogBatchItem.update({
            where: { id: row.id },
            data: {
              status: 'FAILED',
              error: video.error?.message ?? 'Рендер не удался',
              lockedUntil: null,
            },
          });
          await logWorkflowStage(
            this.prisma,
            WorkflowKind.CATALOG_BATCH_ITEM,
            row.id,
            'GENERATING',
            'FAILED',
          );
          renderFailed += 1;
        } else {
          // Всё ещё рендерится или идёт постобработка — снять замок,
          // следующий тик проверит снова.
          await this.prisma.catalogBatchItem
            .update({ where: { id: row.id }, data: { lockedUntil: null } })
            .catch(() => undefined);
        }
      } catch (error) {
        // `getVideoStatus` по контракту не бросает на штатных путях
        // (сетевые сбои возвращают видео без изменений) — но
        // защищаемся: одна сбойная проверка не должна портить весь тик
        // ни ломать досмотр остальных строк.
        this.logger.warn(
          `Проверка статуса рендера (партия ${row.batchId}, товар ${row.productItemId}) не удалась: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
        await this.prisma.catalogBatchItem
          .update({ where: { id: row.id }, data: { lockedUntil: null } })
          .catch(() => undefined);
      }
    }
    return { checked: rows.length, completed, renderFailed };
  }

  /**
   * Доп. запрос владельца продукта (ТЗ §13, этап 2 плана §14) — то же
   * место в цикле тика, что `advanceGenerating()` выше, но для строк,
   * идущих через xAI Batch API вместо синхронного вызова.
   *
   * ⚠️ Форма запроса/ответа Batch API для видео НЕ подтверждена
   * реальным вызовом (см. доккомментарий `GrokVideoBatchService`) —
   * этот метод наследует тот же риск. Не включать на партии с реальными
   * деньгами без предварительного тестового вызова (§13.5 ТЗ).
   */
  private async advanceGrokBatches(): Promise<{
    submitted: number;
    completed: number;
    failed: number;
  }> {
    const submitted = await this.submitReadyGrokBatches();
    const polled = await this.pollInFlightGrokBatches();
    return { submitted, completed: polled.completed, failed: polled.failed };
  }

  /**
   * Партия готова к подаче, когда набралась хотя бы одна `BATCH_QUEUED`
   * строка и ни одной ещё не дошедшей до этого статуса (PENDING или
   * ожидающий повтора FAILED) — одна партия = одна xAI-пачка
   * (`CatalogBatchRun.xaiBatchId` — единственное поле, не список),
   * подавать частями было бы некуда записывать второй ID.
   */
  private async submitReadyGrokBatches(): Promise<number> {
    const grokRuns = await this.prisma.catalogBatchRun.findMany({
      where: { provider: 'grok', xaiBatchId: null },
      select: { id: true, userId: true, resolution: true, aspectRatio: true },
    });

    let submitted = 0;
    for (const run of grokRuns) {
      const [queuedCount, notReadyCount] = await Promise.all([
        this.prisma.catalogBatchItem.count({
          where: { batchId: run.id, status: 'BATCH_QUEUED' },
        }),
        this.prisma.catalogBatchItem.count({
          where: {
            batchId: run.id,
            OR: [
              { status: 'PENDING' },
              { status: 'FAILED', nextAttemptAt: { not: null } },
            ],
          },
        }),
      ]);
      if (queuedCount === 0 || notReadyCount > 0) continue;

      const queuedItems = await this.prisma.catalogBatchItem.findMany({
        where: { batchId: run.id, status: 'BATCH_QUEUED' },
        select: { id: true, sessionId: true, productItemId: true },
      });

      const requestItems: {
        batchRequestId: string;
        prompt: string;
        imageUrl?: string;
        durationSeconds: number;
        aspectRatio: string;
        resolution: GrokResolution;
      }[] = [];
      const skipped: { id: string; reason: string }[] = [];

      for (const item of queuedItems) {
        const session = item.sessionId
          ? await this.sessions.getSession(item.sessionId)
          : null;
        const promptText = session?.generationPrompt?.finalText;
        const imageUrl = session?.productInformation?.productImageUrl;
        if (!promptText || !imageUrl) {
          // Тот же случай, что явно отклоняет `startGrokGeneration`
          // (§15 ТЗ — сессии с персонажами бренда пока не проходят
          // через простой `imageUrl`) — здесь партия просто пропускает
          // эту строку, не рискуя подать пачку без промпта вовсе.
          skipped.push({
            id: item.id,
            reason: !promptText
              ? 'нет одобренного промпта'
              : 'нет фото товара (возможно, сессия с персонажами бренда — reference-to-video для партий не реализован)',
          });
          continue;
        }
        requestItems.push({
          batchRequestId: item.id,
          prompt: promptText,
          imageUrl,
          durationSeconds: VIDEO_DURATION_SECONDS,
          aspectRatio: run.aspectRatio ?? '9:16',
          resolution: (run.resolution as GrokResolution | null) ?? '480p',
        });
      }

      for (const s of skipped) {
        await this.prisma.catalogBatchItem.update({
          where: { id: s.id },
          data: { status: 'FAILED', error: s.reason, lockedUntil: null },
        });
      }

      if (requestItems.length === 0) continue;

      // Найдено при аудите (ТЗ §13, этап 2 плана §14): этот путь
      // вызывает `GrokVideoBatchService` НАПРЯМУЮ, минуя
      // `GenerationService.generateVideo()`, где для ВСЕХ остальных
      // путей генерации в проекте живёт и проверка бюджета, и запись
      // расхода — без этой проверки партия могла бы уйти в xAI без
      // единого взгляда на дневной лимит пользователя. Тот же принцип,
      // что уже применён в §9.4 к цепочкам Scene Extension: стоимость
      // всей партии проверяется заранее, целиком, не по одному
      // элементу за раз.
      const resolutionForPricing =
        (run.resolution as GrokResolution | null) ?? '480p';
      const perItemMicroUsd = estimateCost(
        `${this.grokBatch.modelName}:${resolutionForPricing}`,
        { seconds: VIDEO_DURATION_SECONDS },
      ).costMicroUsd;
      const totalBatchMicroUsd = perItemMicroUsd * requestItems.length;
      const access = await this.plans.accessOf(run.userId);
      const verdict = await this.aiUsage.budget(run.userId, access.spendPlan);
      if (!verdict.allowed || verdict.remainingMicroUsd < totalBatchMicroUsd) {
        this.logger.warn(
          `Grok-пачка для партии ${run.id} (${requestItems.length} строк, ` +
            `${totalBatchMicroUsd} мкд) не помещается в остаток дневного ` +
            `лимита пользователя ${run.userId} — вся партия помечена FAILED, ` +
            `не подана частично`,
        );
        await this.prisma.catalogBatchItem.updateMany({
          where: { id: { in: requestItems.map((r) => r.batchRequestId) } },
          data: {
            status: 'FAILED',
            error:
              'Дневной лимит расхода не покрывает стоимость этой Grok-партии целиком',
            lockedUntil: null,
          },
        });
        continue;
      }

      const result = await this.grokBatch.submitBatch(
        `catalog-batch-${run.id}`,
        requestItems,
      );
      if (result.error) {
        this.logger.warn(
          `Grok-пачка для партии ${run.id} не подана: ${result.error}`,
        );
        // Не FAILED навсегда — как обычная временная неудача (тот же
        // принцип, что recordFailure() для сетевых сбоев): строки
        // остаются BATCH_QUEUED, следующий тик попробует подать снова.
        continue;
      }

      // Расход пишется в момент запуска (тот же принцип, что уже
      // применяется во всех остальных путях этого проекта, §26 ТЗ) —
      // одной записью на партию, не по элементу: xAI выставит счёт за
      // всю пачку, отчёт о расходах должен отражать то же самое.
      await this.aiUsage.record({
        operation: 'generation',
        model: `${this.grokBatch.modelName}:${resolutionForPricing}`,
        seconds: VIDEO_DURATION_SECONDS * requestItems.length,
        sessionId: run.id,
      });

      await this.prisma.catalogBatchRun.update({
        where: { id: run.id },
        data: { xaiBatchId: result.xaiBatchId },
      });
      await this.prisma.catalogBatchItem.updateMany({
        where: { id: { in: requestItems.map((r) => r.batchRequestId) } },
        data: { status: 'GENERATING' },
      });
      submitted += 1;
      this.logger.log(
        `Grok-пачка ${result.xaiBatchId} подана для партии ${run.id} (${requestItems.length} строк, пропущено ${skipped.length}).`,
      );
    }
    return submitted;
  }

  /**
   * Опрашивает уже поданные пачки; по готовности (`pendingCount === 0`)
   * забирает результаты и финализирует каждую строку — то же самое,
   * что синхронный путь делает через `GenerationService.pollGrokStatus`,
   * но здесь напрямую, потому что эти сессии никогда не проходили через
   * синхронный `generateVideo()`.
   */
  private async pollInFlightGrokBatches(): Promise<{
    completed: number;
    failed: number;
  }> {
    const inFlight = await this.prisma.catalogBatchRun.findMany({
      where: {
        provider: 'grok',
        xaiBatchId: { not: null },
        items: { some: { status: 'GENERATING' } },
      },
      select: { id: true, xaiBatchId: true, aspectRatio: true },
    });

    let completed = 0;
    let failed = 0;
    for (const run of inFlight) {
      const status = await this.grokBatch.getBatchStatus(run.xaiBatchId!);
      if (!status || status.pendingCount > 0) continue; // ещё не готово или сбой опроса — попробуем следующим тиком

      const urlsByItemId = await this.grokBatch.getBatchResults(
        run.xaiBatchId!,
      );
      const generatingItems = await this.prisma.catalogBatchItem.findMany({
        where: { batchId: run.id, status: 'GENERATING' },
        select: { id: true, sessionId: true, productItemId: true },
      });

      for (const item of generatingItems) {
        const url = urlsByItemId[item.id];
        if (!url || !item.sessionId) {
          await this.prisma.catalogBatchItem.update({
            where: { id: item.id },
            data: {
              status: 'FAILED',
              error: 'Grok batch завершился без результата для этой строки',
              lockedUntil: null,
            },
          });
          failed += 1;
          continue;
        }

        try {
          await this.finalizeGrokBatchItem(
            item.sessionId,
            url,
            run.aspectRatio ?? '9:16',
          );
          await this.prisma.catalogBatchItem.update({
            where: { id: item.id },
            data: { status: 'DONE', lockedUntil: null },
          });
          completed += 1;
        } catch (error) {
          await this.prisma.catalogBatchItem.update({
            where: { id: item.id },
            data: {
              status: 'FAILED',
              error: error instanceof Error ? error.message : String(error),
              lockedUntil: null,
            },
          });
          failed += 1;
        }
      }
    }
    return { completed, failed };
  }

  /**
   * Скачивает готовое видео Grok-пачки и сохраняет так же, как
   * `GenerationService.pollGrokStatus` сохраняет синхронный путь —
   * та же форма `GeneratedVideo`, тот же Blob. Отдельная копия, не
   * вызов приватного метода `GenerationService` — тот метод завязан на
   * `current: GeneratedVideo`, которого у только что поданной через
   * batch строки никогда не было (сессия не проходила через
   * `generateVideo()` вовсе).
   */
  private async finalizeGrokBatchItem(
    sessionId: string,
    videoUrl: string,
    aspectRatio: string,
  ): Promise<void> {
    const session = await this.sessions.getSession(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    const res = await fetch(videoUrl);
    if (!res.ok) {
      throw new Error(`Grok batch video download HTTP ${res.status}`);
    }
    const videoBuffer = Buffer.from(await res.arrayBuffer());

    const generatedVideoId = uuidv4();
    const pathname = `sessions/${sessionId}/generated-${generatedVideoId}.mp4`;
    const { url: blobUrl } = await this.blob.uploadBuffer(
      pathname,
      videoBuffer,
      'video/mp4',
    );

    const completedVideo: GeneratedVideo = {
      generatedVideoId,
      pathname,
      fileName: 'generated.mp4',
      mimeType: 'video/mp4',
      status: VideoGenerationStatus.COMPLETE,
      initiatedAt: new Date(),
      completedAt: new Date(),
      fileSize: videoBuffer.length,
      downloadUrl: blobUrl,
      provider: 'grok',
      aspectRatio,
      reframePending: false,
      references: [],
    };

    const previous = session.generatedVideo;
    const previousFinished =
      previous &&
      (previous.status === VideoGenerationStatus.COMPLETE ||
        previous.status === VideoGenerationStatus.FAILED);
    const videoHistory = previousFinished
      ? [previous, ...(session.videoHistory ?? [])]
      : (session.videoHistory ?? []);

    await this.sessions.updateSession(sessionId, {
      generatedVideo: completedVideo,
      videoHistory,
      status: SessionStatus.VIDEO_COMPLETE,
    });
  }

  /** Снимок партии — с кэшем на один прогон `runBatch` (несколько строк
   * одной партии не должны читать `CatalogBatchRun` по многу раз).
   * Возвращаемый тип объявлен явно (`Promise<BatchRow>`, не выведен из
   * `findUnique`), потому что без сгенерированного под новые модели
   * Prisma-клиента (см. doc/PRODUCT-PROJECT-SPEC.md про ограничение
   * песочницы) `findUnique` возвращает `any`, и присваивание `any`
   * переменной с объявленным типом `BatchRow | undefined` в TS сбрасывает
   * сужение обратно к объявленному типу на выходе из блока — здесь это
   * обойдено явной сигнатурой функции. */
  private async getBatchCached(
    batchId: string,
    cache: Map<string, BatchRow>,
  ): Promise<BatchRow> {
    const cached = cache.get(batchId);
    if (cached) return cached;
    const found = await this.prisma.catalogBatchRun.findUnique({
      where: { id: batchId },
    });
    if (!found) {
      throw Object.assign(new Error(`CatalogBatchRun ${batchId} not found`), {
        name: 'NotFoundException',
      });
    }
    const batch: BatchRow = found;
    cache.set(batchId, batch);
    return batch;
  }

  /** Пять шагов на один товар, без остановки между ними — но
   * резюмируемо: см. комментарий про Д-2.5 внутри. */
  private async processOne(row: ClaimableRow, batch: BatchRow): Promise<void> {
    let sessionId = row.sessionId;
    if (!sessionId) {
      const session = await this.projectSession.createFromItem(
        batch.userId,
        batch.projectId,
        row.productItemId,
        batch.locale ?? undefined,
      );
      sessionId = session.sessionId;
      await this.prisma.catalogBatchItem.update({
        where: { id: row.id },
        data: { sessionId },
      });
    }

    // Пятый аудит, Д-2.5: строка могла уже частично пройти этот метод в
    // прошлом тике (сессия создана, промпт одобрен, рендер стартован), а
    // затем упасть на последней записи статуса ниже — узкое окно между
    // "рендер и правда стартовал у Veo" и "строка это отразила". Слепой
    // повтор всех шагов заново списал бы GPT-5 второй раз за промпт,
    // который уже не нужен, а generateVideo() всё равно отклонил бы
    // повторный старт своим же замком ("повторный запуск генерации при
    // идущей операции") — строка так и не вышла бы из FAILED, платя
    // GPT-5 на каждой попытке вплоть до maxAttempts. Резюмируем по
    // РЕАЛЬНОМУ состоянию сессии, а не по (возможно не записавшемуся)
    // статусу строки — Veo сам по себе от повторной оплаты уже защищён
    // (тем же замком), но до этой правки до него не всегда доходили —
    // сбоила уже сама попытка повторной генерации промпта.
    const current = await this.sessions.getSession(sessionId);
    const promptApproved = Boolean(current?.generationPrompt?.approvedAt);
    const videoStarted = Boolean(current?.generatedVideo);

    if (!promptApproved && !videoStarted) {
      await this.library.applyToSession(sessionId, batch.libraryEntryId);
      await this.prompt.generatePrompt(sessionId);
      await this.prompt.approvePrompt(sessionId);
    }

    if (batch.provider === 'grok') {
      // Доп. запрос владельца продукта (ТЗ §13, этап 2 плана §14):
      // Grok идёт через xAI Batch API, не через синхронный вызов —
      // сама подача (много строк как ОДНА пачка) происходит отдельно,
      // в `advanceGrokBatches()`, не здесь. Эта строка просто встаёт в
      // очередь на подачу — GPT-5-промпт уже готов и одобрен выше,
      // этого достаточно, чтобы участвовать в следующей подаче.
      if (!videoStarted) {
        await this.prisma.catalogBatchItem.update({
          where: { id: row.id },
          data: { status: 'BATCH_QUEUED', lockedUntil: null, error: null },
        });
        await logWorkflowStage(
          this.prisma,
          WorkflowKind.CATALOG_BATCH_ITEM,
          row.id,
          row.status,
          'BATCH_QUEUED',
        );
      }
      return;
    }

    if (!videoStarted) {
      await this.generation.generateVideo(
        sessionId,
        batch.quality as VideoQuality,
        batch.aspectRatio ?? undefined,
      );
    }

    await this.prisma.catalogBatchItem.update({
      where: { id: row.id },
      data: { status: 'GENERATING', lockedUntil: null, error: null },
    });
    await logWorkflowStage(
      this.prisma,
      WorkflowKind.CATALOG_BATCH_ITEM,
      row.id,
      row.status,
      'GENERATING',
    );
  }

  /** Бэкофф — attempts++, nextAttemptAt = now + 2^attempts мин, тот же
   * приём и та же формула, что у PublishWorkerService/
   * MarketingBroadcastService. Не retryable-ошибка — сразу FAILED, без
   * пустых повторов.
   *
   * Е-1.2 шестого аудита: суточный лимит расхода — особый случай, ни
   * «постоянная» (нужен обычный экспоненциальный бэкофф вида минут —
   * он гарантированно провалится ещё раз, пока не наступят следующие
   * сутки), ни «навсегда» (`nonRetryable`, `nextAttemptAt=null` — строка
   * больше никогда не подхватится, хотя лимит сам снимется завтра).
   * `nextAttemptAt` для неё — начало следующих суток UTC, и `exhausted`
   * для неё не считается вовсе, сколько бы попыток ни накопилось. */
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
    await this.prisma.catalogBatchItem.update({
      where: { id: row.id },
      data: {
        attempts,
        error: message.slice(0, 2000),
        // FAILED и в неисчерпанном случае тоже (не PENDING) — тот же
        // приём, что у PublishWorkerService/MarketingBroadcastService:
        // строку с ещё не наступившим nextAttemptAt воркер просто не
        // выбирает следующим тиком (см. findMany выше), а FAILED с
        // nextAttemptAt=null (после maxAttempts или сразу для
        // non-retryable) не выбирается уже никогда.
        status: 'FAILED',
        nextAttemptAt,
        lockedUntil: null,
      },
    });
    await logWorkflowStage(
      this.prisma,
      WorkflowKind.CATALOG_BATCH_ITEM,
      row.id,
      row.status,
      'FAILED',
    );
    this.logger.warn(
      `Товар ${row.productItemId} (партия ${row.batchId}): попытка ${attempts}/${maxAttempts} не удалась — ${message}` +
        (isDailyLimit
          ? ', суточный лимит расхода — повтор завтра'
          : exhausted
            ? ', дальше не повторяем → FAILED'
            : ''),
    );
  }
}
