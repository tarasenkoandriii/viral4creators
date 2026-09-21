import { Injectable, Logger } from '@nestjs/common';
import { SessionService } from '../../common/session.service';
import { ProjectService } from '../project/project.service';
import { PrismaService } from '../../prisma/prisma.service';
import { BlobService } from '../storage/blob.service';
import { TelegramNotifyService } from '../notify/telegram-notify.service';
import { AiUsageService } from '../ai-usage/ai-usage.service';
import { AdminPanelService } from '../admin-panel/admin-panel.service';
import { LibraryService } from '../library/library.service';
import { BlogGenerationService } from '../blog/blog-generation.service';
import { BlogTranslationService } from '../blog/blog-translation.service';
import {
  PublishBatchResult,
  PublishWorkerService,
} from '../publishing/publish-worker.service';
import {
  BillingRenewalWorkerService,
  RenewalBatchResult,
} from '../billing-renewal/billing-renewal-worker.service';
import {
  MarketingBroadcastResult,
  MarketingBroadcastService,
} from '../marketing/marketing-broadcast.service';
import {
  CatalogBatchRunResult,
  CatalogBatchWorkerService,
} from '../catalog-batch/catalog-batch-worker.service';
import {
  AbTestRunResult,
  AbTestWorkerService,
} from '../ab-test/ab-test-worker.service';
import {
  FeedImportTickResult,
  ProductFeedImportWorkerService,
} from '../product-feed-import/product-feed-import-worker.service';
import { ExportService } from '../export/export.service';
import { ImageSketchService } from '../image-sketch/image-sketch.service';
import { AuctionService } from '../auction/auction.service';
import { AuctionAiAssessmentService } from '../auction/auction-ai-assessment.service';
import { LiveAuctionOrchestratorService } from '../auction/live-auction-orchestrator.service';
import { PortfolioWatermarkService } from '../portfolio/portfolio-watermark.service';
import {
  TutorialScenarioGenerateResult,
  TutorialScenarioGeneratorService,
} from '../tutorial-scenario/tutorial-scenario-generator.service';
import {
  TutorialScenarioRunResult,
  TutorialScenarioRunnerService,
} from '../tutorial-runner/tutorial-scenario-runner.service';
import {
  UiSnapshotRunResult,
  UiSnapshotRunnerService,
} from '../ui-snapshot/ui-snapshot-runner.service';
import {
  EMPTY_KINDS,
  orphanSweepPlan,
  ownerIdOf,
  SWEEP_PREFIX,
  SWEEP_SCOPES,
  SweepScope,
} from '../../common/orphan-sweep';
import { pruneRateLimits } from '../../common/rate-limit';
import {
  pruneAssistantExchanges,
  pruneAssistantEvents,
} from '../assistant/assistant-prune';
import { buildRunSummary } from './cron-run-summary';
import { tryAcquireJobLock, releaseJobLock } from '../../common/cron-job-lock';

/**
 * `triggeredBy` для прогонов НАСТОЯЩЕГО Vercel Cron (`CronController` →
 * `runAndLog`) — у него, в отличие от ручного запуска оператором из
 * админки, нет `req.userId`, поэтому используется одна и та же
 * константа-метка (пятый аудит, Д-4.3).
 */
export const VERCEL_CRON_TRIGGERED_BY = 'vercel-cron';

/**
 * CronJobsService
 *
 * Этап 69 (доп. ТЗ «Кроны в админке»): вся бизнес-логика десяти
 * крон-задач, извлечённая из `CronController` без единой смены
 * поведения (чистый extract-method) — единственный источник истины,
 * которым пользуются ДВА вызывающих:
 *
 * 1. `CronController` (`GET /api/cron/*`) — настоящий крон Vercel,
 *    закрыт `CRON_SECRET` (см. `cron-secret.ts`).
 * 2. `AdminCronController` (`POST /admin/cron/:jobKey/run`) — ручной
 *    запуск оператором из админки, закрыт `AdminSessionGuard` +
 *    `assertOperator`, с необязательным флагом debug (см.
 *    `admin-cron.service.ts` — там же решено, что именно debug
 *    показывает для каждого из десяти джобов).
 *
 * До этапа 69 вся эта логика жила прямо в `CronController` — единый
 * вызывающий делал разделение не нужным. С появлением второго вызывающего
 * дублировать ~300 строк `runCleanupSessions`/`runSweepOrphans` означало
 * бы держать одну и ту же логику в двух местах и рано или поздно развести
 * их поведение по ошибке — сюда переехало тело каждого маршрута, имя
 * метода стало `runX` вместо прежнего имени handler'а.
 */
export const CLEANUP_MAX_PASSES = 20;
export const CLEANUP_TIME_BUDGET_MS = 120_000;
const SWEEP_MAX_PAGES = 40;
const SWEEP_TIME_BUDGET_MS = 120_000;

export interface SweepOrphansOptions {
  cursor?: string;
  limit?: string;
  minAgeHours?: string;
  dryRun?: string;
}

export interface SweepOrphansResult {
  scanned: number;
  orphanSessions: number;
  orphanOwners: number;
  deleted: number;
  byKind: Record<string, number>;
  byScope: Record<
    string,
    { scanned: number; orphans: number; pages: number; complete: boolean }
  >;
  oldestUploadedAt: string | null;
  skippedTooNew: number;
  skippedUnknown: number;
  dryRun: boolean;
  /** Все области досмотрены до конца; иначе «orphans: 0» ничего не значит. */
  complete: boolean;
  cursor: string | null;
}

export interface CleanupSessionsResult {
  deletedCount: number;
  deletedBlobs: number;
  hasMoreSessions: boolean;
  deletedAdminSessions: number;
  deletedUserSessions: number;
  deletedLibraryEntries: number;
  hasMoreLibraryEntries: boolean;
  /**
   * Этап 89: Project/ProductItem/Session, мягко удалённые (`deletedAt`)
   * пользователем или оператором и старше `SOFT_DELETE_GRACE_MS` — физически
   * убраны этим прогоном. Тот же суточный джоб, не отдельный: см.
   * доккомментарий `runCleanupSessions` ниже.
   */
  purgedSoftDeletedSessions: number;
  purgedSoftDeletedProjects: number;
  purgedSoftDeletedItems: number;
  /** Хоть один из трёх счётчиков выше уперся в `PURGE_BATCH`/`CLEANUP_BATCH`
   * за отведённые партии/время — остаток доберёт завтрашний прогон. */
  hasMoreSoftDeleted: boolean;
  /**
   * Найдено доп. аудитом (MEDIUM) — тот же приём джоб-замка, что уже
   * есть у `runBlog`/`runExportSyncRun` (см. `common/cron-job-lock.ts`):
   * этот джоб зовётся и суточным расписанием (`cron.controller.ts`), и
   * ручной кнопкой в админке (`admin-cron.service.ts`) — двойной клик
   * оператора поверх уже идущего суточного прогона мог бы удвоить
   * партии `deleteMany`/`purgeSoftDeleted*` и уборку блобов. `true`,
   * когда замок уже держал другой прогон — остальные поля тогда нулевые
   * (ничего не сделано, не «сделано и получилось 0»). */
  skipped?: boolean;
}

@Injectable()
export class CronJobsService {
  private readonly logger = new Logger(CronJobsService.name);

  constructor(
    private readonly sessionService: SessionService,
    private readonly projectService: ProjectService,
    private readonly prisma: PrismaService,
    private readonly blobService: BlobService,
    private readonly notify: TelegramNotifyService,
    private readonly aiUsage: AiUsageService,
    private readonly adminPanel: AdminPanelService,
    private readonly library: LibraryService,
    private readonly blogGeneration: BlogGenerationService,
    private readonly blogTranslation: BlogTranslationService,
    private readonly publishWorker: PublishWorkerService,
    private readonly billingRenewal: BillingRenewalWorkerService,
    private readonly marketingBroadcast: MarketingBroadcastService,
    private readonly catalogBatchWorker: CatalogBatchWorkerService,
    private readonly abTestWorker: AbTestWorkerService,
    private readonly feedImportWorker: ProductFeedImportWorkerService,
    private readonly exportService: ExportService,
    private readonly tutorialScenarioGenerator: TutorialScenarioGeneratorService,
    private readonly tutorialScenarioRunner: TutorialScenarioRunnerService,
    private readonly uiSnapshotRunner: UiSnapshotRunnerService,
    private readonly imageSketch: ImageSketchService,
    private readonly auctionService: AuctionService,
    private readonly auctionAiAssessment: AuctionAiAssessmentService,
    private readonly liveAuctionOrchestrator: LiveAuctionOrchestratorService,
    private readonly portfolioWatermark: PortfolioWatermarkService,
  ) {}

  /**
   * Оборачивает один прогон НАСТОЯЩЕГО крона (`CronController`, вызван
   * Vercel Cron) записью `CronRunLog` — пятый аудит, Д-4.3: до этой
   * правки строку в истории заводил только ручной запуск оператором из
   * админки (`AdminCronService.run()`), и вкладка «Кроны» не могла
   * показать, что реальные автоматические прогоны вообще происходят.
   *
   * Сознательно НЕ переиспользует `AdminCronService.run()` и не
   * рефакторится под общий с ним метод: `run()` уже покрыт 11 тестами,
   * ГЛОТАЕТ ошибку джоба в FAILED-строку (клиент видит красивый ответ,
   * а не 500) и возвращает `CronRunLogRow` для отображения в админке.
   * Здесь — ровно наоборот: `cron.controller.ts` должен продолжать
   * отвечать 500 на необработанную ошибку джоба, как и до этой правки
   * (это НЕ ручной клик оператора — это то, что видит Vercel Cron), так
   * что `runAndLog` пишет FAILED-строку и ПЕРЕБРАСЫВАЕТ ошибку дальше,
   * а не возвращает её как значение. Сама сводка (`buildRunSummary`) —
   * общий чистый модуль, чтобы не расходиться в форматировании.
   */
  async runAndLog<T>(
    jobKey: string,
    triggeredBy: string,
    debugMode: boolean,
    task: () => Promise<T>,
  ): Promise<T> {
    const row = await this.prisma.cronRunLog.create({
      data: { jobKey, triggeredBy, debugMode, status: 'RUNNING' },
    });
    const startedAt = Date.now();
    try {
      const result = await task();
      const durationMs = Date.now() - startedAt;
      await this.prisma.cronRunLog.update({
        where: { id: row.id },
        data: {
          status: 'SUCCESS',
          finishedAt: new Date(),
          durationMs,
          summary: buildRunSummary(jobKey, result),
          debugLog: debugMode ? (result as object) : undefined,
        },
      });
      return result;
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      await this.prisma.cronRunLog.update({
        where: { id: row.id },
        data: {
          status: 'FAILED',
          finishedAt: new Date(),
          durationMs,
          summary: `Ошибка: ${errorMessage}`,
          errorMessage,
        },
      });
      throw error; // в отличие от AdminCronService.run() — сохраняем поведение реального крона (необработанная ошибка → 500)
    }
  }

  /**
   * Суточный отчёт в канал статистики (ТЗ §28). См. доккомментарий,
   * прежде живший на `CronController.report`.
   */
  async runReport(): Promise<{ sent: boolean; text: string }> {
    const [telemetry, cost, suppressed] = await Promise.all([
      this.adminPanel.getTelemetry(),
      this.aiUsage.report(5),
      this.notify.suppressedSummary(),
    ]);
    const money = (micro: number) => `$${(micro / 1_000_000).toFixed(2)}`;
    const weekly = new Date().getUTCDay() === 1;

    const lines = [
      `📊 Отчёт за сутки${weekly ? ' и неделю' : ''}`,
      `Сессий всего: ${telemetry.total}, за сутки: ${telemetry.createdLast24h}` +
        (weekly ? `, за неделю: ${telemetry.createdLast7d}` : ''),
      `Провалов генерации: ${telemetry.failedGenerations}`,
      `Расход за сутки: ${money(cost.last24hMicroUsd)}` +
        (weekly ? `, за неделю: ${money(cost.last7dMicroUsd)}` : '') +
        `, всего: ${money(cost.totalMicroUsd)}`,
      `Анонимный расход: ${money(cost.anonymousMicroUsd)}, сегодня из общего потолка: ${money(cost.anonymousSpentTodayMicroUsd)}`,
      `Вызовов без ставки в прайсе: ${cost.unpricedCalls}`,
      `Платящих пользователей: ${cost.payingUsers}, сессий с расходом: ${cost.sessionsWithCost}`,
    ];
    const statuses = Object.entries(telemetry.byStatus)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([k, n]) => `${k}=${n}`)
      .join(', ');
    if (statuses) lines.push(`По статусам: ${statuses}`);
    if (suppressed.length > 0) {
      lines.push(
        `Повторов тревог, не показанных в канале: ${suppressed
          .map((s) => `${s.fingerprint} ×${s.suppressed}`)
          .join(', ')}`,
      );
    }

    const text = lines.join('\n');
    const sent = await this.notify.report(text);
    if (sent) {
      this.logger.log(`Отчёт отправлен в канал статистики: ${lines[1]}`);
    } else {
      this.logger.warn(
        `Отчёт НЕ отправлен (канал не настроен или Telegram недоступен): ${lines[1]}`,
      );
    }
    return { sent, text };
  }

  /**
   * Суточный крон блога (doc/TODO.md §II.3, ТЗ §36, этап 57): генерация
   * черновиков + очередь перевода + бэкофилл обложек (этап 95, третий
   * шаг), одним вызовом — тот же принцип экономии крон-слотов Vercel
   * Hobby, что уже объединил первые два шага.
   */
  async runBlog(): Promise<{
    generation: Awaited<
      ReturnType<BlogGenerationService['runDailyGeneration']>
    >;
    translation: Awaited<
      ReturnType<BlogTranslationService['runTranslationCron']>
    >;
    coverBackfill: Awaited<
      ReturnType<BlogGenerationService['runCoverImageBackfill']>
    >;
  }> {
    // М-3.9 седьмого аудита: без джоб-замка двойной клик оператора на
    // «blog» подавал одни и те же переводы двумя оплаченными пачками и
    // дважды звал Gemini для черновиков. Тот же замок, что у остальных
    // крон-воркеров.
    const acquired = await tryAcquireJobLock(this.prisma, 'blog');
    if (!acquired) {
      this.logger.warn(
        'Крон блога: предыдущий прогон ещё держит замок — пропуск',
      );
      return {
        generation: { skipped: true } as never,
        translation: { skipped: true } as never,
        coverBackfill: { skipped: true } as never,
      };
    }
    try {
      const generation = await this.blogGeneration.runDailyGeneration();
      const translation = await this.blogTranslation.runTranslationCron();
      const coverBackfill = await this.blogGeneration.runCoverImageBackfill();
      this.logger.log(
        `Крон блога: генерация ${JSON.stringify(generation)}, перевод ${JSON.stringify(translation)}, бэкофилл обложек ${JSON.stringify(coverBackfill)}`,
      );
      return { generation, translation, coverBackfill };
    } finally {
      await releaseJobLock(this.prisma, 'blog', acquired);
    }
  }

  /** Крон-воркер выгрузки одобренных заявок в YouTube/TikTok (этап 61). */
  async runPublish(): Promise<PublishBatchResult> {
    return this.publishWorker.runBatch();
  }

  /** Крон-воркер продления подписок (этап 62). */
  async runBillingRenew(): Promise<RenewalBatchResult> {
    return this.billingRenewal.runBatch();
  }

  /** Рассылка подборки удачных роликов подписчикам (этап 63). */
  async runMarketingBroadcast(): Promise<MarketingBroadcastResult> {
    return this.marketingBroadcast.runDaily();
  }

  /** Обработка партий пакетной генерации по каталогу (этап 65). */
  async runCatalogBatchRun(): Promise<CatalogBatchRunResult> {
    return this.catalogBatchWorker.runBatch();
  }

  /** Обработка A/B-вариантов одного ролика (этап 66). */
  async runAbTestRun(): Promise<AbTestRunResult> {
    return this.abTestWorker.runBatch();
  }

  /** Импорт товарного фида по ссылке (этап 68). */
  async runFeedImportRun(): Promise<FeedImportTickResult> {
    return this.feedImportWorker.runTick();
  }

  /**
   * Закрытие аукционных лотов по дедлайну (ТЗ на маркетплейс §22, Этап
   * 2) — WON/EXPIRED и продвижение следующего из очереди на освободившееся
   * место. См. доккомментарий `AuctionService.closeExpiredListings`.
   */
  async runAuctionClose(): Promise<{ closed: number }> {
    return this.auctionService.closeExpiredListings();
  }

  /**
   * ИИ-оценка видео/брендбука для аукциона (ТЗ на маркетплейс §22,
   * Этап 3) — одна заявка за тик, см. доккомментарий
   * AuctionAiAssessmentService.runTick про то, почему фоново, а не
   * синхронно при подаче.
   */
  async runAuctionAssess(): Promise<{ assessed: boolean }> {
    return this.auctionAiAssessment.runTick();
  }

  /**
   * Подстраховка паузы Google Ads-кампаний блиц-лотов (ТЗ на маркетплейс
   * §22, аудит-фикс GoogleAdsService/AuctionService) — см. доккомментарий
   * AuctionService.reconcileGoogleAdsCampaigns про то, почему
   * fire-and-forget вызов паузы из пользовательского запроса
   * (withdraw/placeBid) в serverless может не долететь, и почему это
   * не симметрично для создания кампании (риск дублей).
   */
  async runAuctionGoogleAdsSync(): Promise<{ paused: number; stillStuck: number }> {
    return this.auctionService.reconcileGoogleAdsCampaigns();
  }

  /**
   * Живой аукцион (docs-tz/TZ-Virtualnaya-Studiya-i-AI-Vedushaya.md §7.5,
   * Этап 5) — авто-сворачивание трансляций без ставок за
   * `LIVE_NO_BID_COLLAPSE_MIN` минут (см. LiveAuctionOrchestratorService).
   * Заодно подчищает подсказки, зависшие в 'pending' (аудит, сверка с
   * SilverFinance — см. доккомментарий STALE_PENDING_CUE_MS там же).
   * Сам аукцион продолжается — сворачивается только эфир, не торги.
   * Тот же тик раз в 2 минуты, что у остальных тик-воркеров этого списка.
   */
  async runLiveAuctionTick(): Promise<{ collapsed: number; reapedStalePendingCues: number }> {
    return this.liveAuctionOrchestrator.collapseInactiveStreams();
  }

  /**
   * Водяной знак на превью портфолио/аукциона (ТЗ на маркетплейс
   * §9/§22, защита от пиратства) — одно действие (отправка или опрос)
   * за тик, см. доккомментарий PortfolioWatermarkService.runTick.
   *
   * Аудит-фикс: раньше здесь не было джоб-уровневого замка — единственный
   * тик-воркер в этом файле без него. `runTick()` делает `findFirst` +
   * безусловный `update` (не `updateMany` с условием, как у построчных
   * claim'ов в export-sync-run/ui-snapshot-run) — два перекрывающихся
   * прогона (тик крона раз в 2 минуты + ручной запуск оператором той же
   * `jobKey` в админке, тот самый путь, из-за которого джоб-лок вообще
   * появился в проекте — см. доккомментарий cron-job-lock.ts) могли
   * оба забрать ОДИН И ТОТ ЖЕ PENDING-элемент, оба вызвать платный
   * `ffmpeg.submit()` и затем оба перезаписать `watermarkJobId` — job id
   * проигравшего теряется без единой записи о себе (тот же класс ошибки,
   * что и premature-nulling до FAILED-фикса, см. AUDIT-Portfolio-
   * Watermark.md, только через гонку, а не через порядок операций), и
   * задваивается платный вызов. То же для `pollJob()` — двойная запись в
   * AiUsageService при завершённом джобе задваивала бы расход в отчёте
   * (§26). Тот же приём, что у остальных тик-воркеров этого файла.
   */
  async runPortfolioWatermark(): Promise<{ action: string }> {
    const acquired = await tryAcquireJobLock(this.prisma, 'portfolio-watermark');
    if (!acquired) return { action: 'skipped-locked' };
    try {
      return await this.portfolioWatermark.runTick();
    } finally {
      await releaseJobLock(this.prisma, 'portfolio-watermark', acquired);
    }
  }

  /**
   * Крон-аналог `advanceGenerating()` для автоэкспорта яруса B (Е-2.3
   * шестого аудита, этап 76) — досматривает статус дочерних рендеров
   * независимо от того, открыт ли у пользователя экран прогресса. См.
   * доккомментарий `ExportService.runSyncTick`.
   */
  async runExportSyncRun(): Promise<{ checked: number; failed: number }> {
    // М-3.9 седьмого аудита: два перекрывающихся тика опрашивали одну
    // дочернюю сессию параллельно.
    const acquired = await tryAcquireJobLock(this.prisma, 'export-sync-run');
    if (!acquired) return { checked: 0, failed: 0 };
    try {
      return await this.exportService.runSyncTick();
    } finally {
      await releaseJobLock(this.prisma, 'export-sync-run', acquired);
    }
  }

  /**
   * Генерация сценариев для будущей автозаписи обучающих видео (этап
   * 94, doc/TMA-UI-SNAPSHOT-AND-TUTORIAL-VIDEO-SPEC.md §4.10) — один
   * прогон Gemini-текстом на шаг обучалки, без браузера/видео (§5 того
   * же ТЗ пока не реализован). Джоб-лок тем же приёмом, что у
   * `runExportSyncRun`/`runBlog` — прогон делает десять сетевых вызовов
   * подряд, не мгновенный, и расписание нечастое (раз в сутки,
   * `backend/vercel.json`), но перекрытие всё равно возможно при ручном
   * повторном запуске оператором.
   */
  async runTutorialScenarioGenerate(): Promise<TutorialScenarioGenerateResult> {
    const acquired = await tryAcquireJobLock(
      this.prisma,
      'tutorial-scenario-generate',
    );
    if (!acquired) {
      return {
        subjectKeys: 0,
        generated: 0,
        costly: 0,
        failed: 0,
        failures: [],
      };
    }
    try {
      return await this.tutorialScenarioGenerator.run();
    } finally {
      await releaseJobLock(this.prisma, 'tutorial-scenario-generate', acquired);
    }
  }

  /**
   * Исполнение уже сгенерированных сценариев (этап 97, §5 ТЗ) —
   * отдельный крон-слот и отдельный джоб-лок от `tutorial-scenario-
   * generate` (см. доккомментарий `TutorialRunnerModule`): прогон
   * держит открытым настоящий headless-браузер несколько минут (до
   * `RUN_DEADLINE_MS`), и повторный запуск оператором из админки поверх
   * ещё идущего не должен открывать второй Chromium параллельно.
   */
  async runTutorialScenarioRun(): Promise<TutorialScenarioRunResult> {
    const acquired = await tryAcquireJobLock(
      this.prisma,
      'tutorial-scenario-run',
    );
    if (!acquired) {
      return {
        skipped: 'предыдущий прогон ещё не завершился',
        total: 0,
        passed: 0,
        failed: 0,
        outcomes: [],
      };
    }
    try {
      return await this.tutorialScenarioRunner.run();
    } finally {
      await releaseJobLock(this.prisma, 'tutorial-scenario-run', acquired);
    }
  }

  /**
   * Крон-обход интерфейса TMA (этап 100, §3 ТЗ, «Фаза 1» дорожной карты
   * §6.1) — снимает скриншоты фиксированного списка маршрутов (§3.8),
   * сравнивает с предыдущим снимком той же комбинации маршрут×локаль×
   * тема, при расхождении шлёт тревогу. Джоб-лок тем же приёмом, что у
   * `runTutorialScenarioRun` — прогон держит headless-браузер открытым
   * несколько минут, повторный запуск (расписание раз в две минуты,
   * `backend/vercel.json`, тот же темп, что у `catalog-batch-run` и
   * соседей) не должен открывать второй Chromium поверх ещё идущего.
   */
  async runUiSnapshotRun(): Promise<UiSnapshotRunResult> {
    const acquired = await tryAcquireJobLock(this.prisma, 'ui-snapshot-run');
    if (!acquired) {
      return {
        skipped: 'предыдущий прогон ещё не завершился',
        total: 0,
        changed: 0,
        failed: 0,
        outcomes: [],
      };
    }
    try {
      return await this.uiSnapshotRunner.run();
    } finally {
      await releaseJobLock(this.prisma, 'ui-snapshot-run', acquired);
    }
  }

  /**
   * Уборка истёкших сессий/admin- и user-сессий/невостребованной
   * библиотеки. Партиями до конца, с потолком по числу партий и по
   * времени — см. доккомментарий, прежде живший на
   * `CronController.cleanupSessions`.
   *
   * ## Софт-delete Project/ProductItem/Session (этап 89)
   *
   * Тот же прогон физически убирает Project/ProductItem/Session, мягко
   * удалённые пользователем («умный» алерт + `deletedAt`,
   * `ProjectService`/`SessionService`) или оператором в админке дольше
   * `SOFT_DELETE_GRACE_MS` (`common/soft-delete.ts`) назад — НЕ отдельный
   * крон-джоб: заводить ради этого ещё одну запись в `vercel.json`/
   * `JOB_REGISTRY` означало бы держать в расписании два похожих суточных
   * прохода вместо одного, а смысл у обоих один — «убрать то, что уже
   * никому не нужно». Тот же приём, что уже объединяет в этом методе TTL
   * сессий, admin/user-сессии и библиотеку.
   *
   * ## Чего этот метод НЕ чистит (пятый аудит, Д-4.4)
   *
   * `CatalogBatchRun`/`CatalogBatchItem`, `AbTestRun`/`AbTestVariant`,
   * `ProductFeedImportRun`/`ProductFeedImportItem` (этапы 65–68) растут
   * без ограничения САМИ ПО СЕБЕ — ни этот метод, ни какой-либо другой
   * джоб из `JOB_REGISTRY` их не трогает НАПРЯМУЮ. Осознанно принятый
   * риск при текущем масштабе (см. doc/DEPLOYMENT.md — известное
   * ограничение), а не забытая правка; при росте объёма нужен отдельный
   * джоб. Софт-delete проекта (этап 89) их косвенно уносит — но только
   * вместе с целым проектом (DB-каскад в `purgeSoftDeletedProjects`), не
   * как самостоятельную уборку.
   *
   * ## Джоб-замок (найдено доп. аудитом, MEDIUM)
   *
   * Этот метод зовётся и суточным расписанием (`cron.controller.ts`), и
   * ручной кнопкой в админке (`admin-cron.service.ts`) — тот же второй
   * путь к перекрытию, что уже обосновал замок у `runBlog`/
   * `runExportSyncRun` (см. доккомментарий `common/cron-job-lock.ts`):
   * двойной клик оператора поверх уже идущего суточного прогона мог бы
   * удвоить партии `deleteMany`/`purgeSoftDeleted*` и повторно запустить
   * уборку одних и тех же блобов. Сама раскладка на партии внутри
   * прогона (`CLEANUP_MAX_PASSES`/`CLEANUP_TIME_BUDGET_MS` ниже) от
   * этого не спасала — она не даёт ОДНОМУ прогону зависнуть, а не два
   * прогона друг друга обогнать.
   */
  /**
   * Свёртка журнала расходов (doc/TODO.md §I-Б.5, этап 118).
   *
   * Отдельный джоб, а не довесок к уборке сессий: та работает с файлами
   * и строками пользователя, эта — с деньгами, и её обрыв на середине
   * означал бы не «уберём в следующий раз», а расхождение в отчёте. Свой
   * замок по той же причине: два параллельных прогона на одном месяце
   * — это удвоенная свёртка.
   */
  async runAiUsageRollup(): Promise<{
    months: string[];
    foldedRows: number;
    deletedRows: number;
    skipped?: boolean;
  }> {
    const acquired = await tryAcquireJobLock(this.prisma, 'ai-usage-rollup');
    if (!acquired) {
      this.logger.warn(
        'Свёртка журнала расходов: предыдущий прогон ещё держит замок — пропуск',
      );
      return { months: [], foldedRows: 0, deletedRows: 0, skipped: true };
    }
    try {
      return await this.aiUsage.rollupOldMonths();
    } finally {
      await releaseJobLock(this.prisma, 'ai-usage-rollup', acquired);
    }
  }

  async runCleanupSessions(): Promise<CleanupSessionsResult> {
    const acquired = await tryAcquireJobLock(this.prisma, 'cleanup-sessions');
    if (!acquired) {
      this.logger.warn(
        'Крон уборки сессий: предыдущий прогон ещё держит замок — пропуск',
      );
      return {
        deletedCount: 0,
        deletedBlobs: 0,
        hasMoreSessions: false,
        deletedAdminSessions: 0,
        deletedUserSessions: 0,
        deletedLibraryEntries: 0,
        hasMoreLibraryEntries: false,
        purgedSoftDeletedSessions: 0,
        purgedSoftDeletedProjects: 0,
        purgedSoftDeletedItems: 0,
        hasMoreSoftDeleted: false,
        skipped: true,
      };
    }
    try {
      return await this.runCleanupSessionsLocked();
    } finally {
      await releaseJobLock(this.prisma, 'cleanup-sessions', acquired);
    }
  }

  /** Тело прогона — вынесено из `runCleanupSessions` НЕИЗМЕНЁННЫМ, чтобы
   * новый джоб-замок обёртки выше не заставлял переотступать ~150 строк
   * существующей логики партий (см. её доккомментарий). */
  private async runCleanupSessionsLocked(): Promise<CleanupSessionsResult> {
    const started = Date.now();
    // Уборка ИИ-скетчей (§6.7 ТЗ скетча) — тем же суточным прогоном:
    // отдельная запись в `vercel.json` ради двух запросов не нужна.
    // Best-effort: сбой уборки картинок не должен ронять уборку сессий.
    try {
      const sketches = await this.imageSketch.runCleanupTick();
      if (sketches.expired > 0 || sketches.purged > 0) {
        this.logger.log(
          `уборка ИИ-скетчей: просрочено кандидатов ${sketches.expired}, ` +
            `убрано файлов вытесненных ${sketches.purged}`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `уборка ИИ-скетчей не выполнена: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    let expired = await this.sessionService.cleanupExpiredSessions();
    let passes = 1;
    const collected = [...expired.blobPathnames];
    let deletedCount = expired.count;
    while (
      expired.hasMore &&
      passes < CLEANUP_MAX_PASSES &&
      Date.now() - started < CLEANUP_TIME_BUDGET_MS
    ) {
      expired = await this.sessionService.cleanupExpiredSessions();
      collected.push(...expired.blobPathnames);
      deletedCount += expired.count;
      passes += 1;
    }
    if (expired.hasMore) {
      this.logger.warn(
        `истёкших сессий осталось больше, чем помещается в один прогон ` +
          `(${passes} парти(и/й), ${deletedCount} удалено) — доберём завтра; ` +
          'если это повторяется каждый день, поднимайте CLEANUP_MAX_PASSES',
      );
    }

    // Этап 89 — три отдельных цикла партий, один на сущность: у каждой
    // свой курсор (`deletedAt`) и свой лимит партии (`PURGE_BATCH` в
    // project.service.ts / `CLEANUP_BATCH` здесь), путать их в один цикл
    // значило бы гонять пустые прогоны по уже опустевшей сущности, пока
    // другая ещё не досмотрена. Session отдаёт пути файлов сюда (у
    // сервиса своего BlobService нет — тот же приём, что у TTL-уборки
    // выше); Project/ProductItem чистят свои файлы сами (`ProjectService`
    // уже держит `BlobService`).
    let purgedSessions = await this.sessionService.purgeSoftDeletedSessions();
    let sessionPurgePasses = 1;
    let purgedSessionsCount = purgedSessions.count;
    collected.push(...purgedSessions.blobPathnames);
    while (
      purgedSessions.hasMore &&
      sessionPurgePasses < CLEANUP_MAX_PASSES &&
      Date.now() - started < CLEANUP_TIME_BUDGET_MS
    ) {
      purgedSessions = await this.sessionService.purgeSoftDeletedSessions();
      collected.push(...purgedSessions.blobPathnames);
      purgedSessionsCount += purgedSessions.count;
      sessionPurgePasses += 1;
    }

    let purgedProjects = await this.projectService.purgeSoftDeletedProjects();
    let projectPurgePasses = 1;
    let purgedProjectsCount = purgedProjects.count;
    while (
      purgedProjects.hasMore &&
      projectPurgePasses < CLEANUP_MAX_PASSES &&
      Date.now() - started < CLEANUP_TIME_BUDGET_MS
    ) {
      purgedProjects = await this.projectService.purgeSoftDeletedProjects();
      purgedProjectsCount += purgedProjects.count;
      projectPurgePasses += 1;
    }

    let purgedItems = await this.projectService.purgeSoftDeletedItems();
    let itemPurgePasses = 1;
    let purgedItemsCount = purgedItems.count;
    while (
      purgedItems.hasMore &&
      itemPurgePasses < CLEANUP_MAX_PASSES &&
      Date.now() - started < CLEANUP_TIME_BUDGET_MS
    ) {
      purgedItems = await this.projectService.purgeSoftDeletedItems();
      purgedItemsCount += purgedItems.count;
      itemPurgePasses += 1;
    }

    const hasMoreSoftDeleted =
      purgedSessions.hasMore || purgedProjects.hasMore || purgedItems.hasMore;
    if (hasMoreSoftDeleted) {
      this.logger.warn(
        `мягко удалённых старше грейс-периода осталось больше, чем ` +
          `помещается в один прогон (sessions=${purgedSessionsCount}, ` +
          `projects=${purgedProjectsCount}, items=${purgedItemsCount}) — ` +
          'доберём завтра',
      );
    }

    let deletedBlobs = 0;
    try {
      deletedBlobs = await this.blobService.deleteMany(collected);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Сессии удалены (${deletedCount}), но их файлы убрать не удалось: ${message}. ` +
          'Мусор подберёт метла (sweep-orphans) — она в том же суточном расписании.',
      );
    }
    this.logger.log(
      `Cleaned up ${deletedCount} expired session(s) in ${passes} pass(es), ` +
        `${deletedBlobs}/${collected.length} blob(s); ` +
        `purged soft-deleted: ${purgedSessionsCount} session(s), ` +
        `${purgedProjectsCount} project(s), ${purgedItemsCount} item(s)` +
        (expired.hasMore
          ? ' — истёкших осталось больше, доберём следующим прогоном'
          : ''),
    );

    const now = new Date();
    const [adminResult, userResult, , library, , assistantExchangesPruned] =
      await Promise.all([
        this.prisma.adminSession.deleteMany({
          where: { expiresAt: { lt: now } },
        }),
        this.prisma.userSession.deleteMany({
          where: { expiresAt: { lt: now } },
        }),
        // Этап 47: отпечатки тревог живут в базе — убираем забытые здесь
        // же, чтобы таблица не была единственной без уборки.
        this.notify.pruneStates(now),
        // Этап 51 (В-4.6): невостребованные разборы библиотеки — вторая по
        // скорости роста таблица, до этого не чистилась ничем.
        this.library.pruneUnused(now),
        // Этап 54 (Б-3.7): закрывшиеся окна счётчиков частоты.
        pruneRateLimits(this.prisma, now).catch((error: unknown) => {
          this.logger.warn(
            `не удалось убрать счётчики частоты: ${error instanceof Error ? error.message : String(error)}`,
          );
          return 0;
        }),
        // ИИ-консультант на лендинге (ТЗ §10): ретенция 30 дней у обеих
        // журнальных таблиц — обмены и клиентские события виджета.
        pruneAssistantExchanges(this.prisma, now).catch((error: unknown) => {
          this.logger.warn(
            `не удалось убрать журнал ИИ-консультанта: ${error instanceof Error ? error.message : String(error)}`,
          );
          return 0;
        }),
        pruneAssistantEvents(this.prisma, now).catch((error: unknown) => {
          this.logger.warn(
            `не удалось убрать события ИИ-консультанта: ${error instanceof Error ? error.message : String(error)}`,
          );
          return 0;
        }),
      ]);
    this.logger.log(
      `Cleaned up ${adminResult.count} expired admin session(s), ${userResult.count} expired user session(s), ${assistantExchangesPruned} assistant exchange(s)` +
        (library.disabled
          ? ''
          : `, ${library.count} unused library entr(y/ies)${library.hasMore ? ' (есть ещё, доберём завтра)' : ''}`),
    );

    return {
      deletedCount,
      deletedBlobs,
      hasMoreSessions: expired.hasMore,
      deletedAdminSessions: adminResult.count,
      deletedUserSessions: userResult.count,
      deletedLibraryEntries: library.count,
      hasMoreLibraryEntries: library.hasMore,
      purgedSoftDeletedSessions: purgedSessionsCount,
      purgedSoftDeletedProjects: purgedProjectsCount,
      purgedSoftDeletedItems: purgedItemsCount,
      hasMoreSoftDeleted,
    };
  }

  /**
   * Метла по осиротевшим файлам четырёх областей хранилища — см.
   * доккомментарий, прежде живший на `CronController.sweepOrphans`.
   */
  async runSweepOrphans(
    opts: SweepOrphansOptions = {},
  ): Promise<SweepOrphansResult> {
    const { cursor, limit, minAgeHours, dryRun } = opts;
    const pageLimit = Math.min(
      Math.max(parseInt(limit ?? '500', 10) || 500, 1),
      1000,
    );
    const hours = Math.max(parseInt(minAgeHours ?? '24', 10) || 24, 1);
    const isDryRun = dryRun === '1' || dryRun === 'true';
    const now = new Date();

    const totals = {
      scanned: 0,
      deleted: 0,
      planned: 0,
      orphanOwners: 0,
      skippedTooNew: 0,
      skippedUnknown: 0,
    };
    const byKind: Record<string, number> = { ...EMPTY_KINDS };
    const byScope: Record<
      string,
      { scanned: number; orphans: number; pages: number; complete: boolean }
    > = {};
    let oldestUploadedAt: string | null = null;
    let orphanSessions = 0;
    let sessionsCursor: string | null = null;
    const started = Date.now();
    let pagesUsed = 0;
    let complete = true;

    for (const scope of SWEEP_SCOPES) {
      byScope[scope] = { scanned: 0, orphans: 0, pages: 0, complete: false };
      let pageCursor: string | undefined =
        scope === 'sessions' ? cursor : undefined;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (
          pagesUsed >= SWEEP_MAX_PAGES ||
          Date.now() - started >= SWEEP_TIME_BUDGET_MS
        ) {
          complete = false;
          this.logger.warn(
            `Метла упёрлась в потолок (${pagesUsed} страниц, ${Math.round((Date.now() - started) / 1000)} с) на области ${SWEEP_PREFIX[scope]} — остаток досмотрит следующий прогон`,
          );
          break;
        }
        let page: Awaited<ReturnType<BlobService['listByPrefix']>>;
        try {
          page = await this.blobService.listByPrefix(SWEEP_PREFIX[scope], {
            cursor: pageCursor,
            limit: pageLimit,
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          this.logger.error(
            `Метла не смогла прочитать хранилище (${SWEEP_PREFIX[scope]}): ${message}. Проверьте BLOB_READ_WRITE_TOKEN и доступность Vercel Blob.`,
          );
          // Пятый аудит, Д-2.3: до этой правки CronRunLog на упавшей
          // метле писал FAILED без единого числа о том, что уже успело
          // случиться — а к этому месту прошлые страницы/области могли
          // уже реально удалить файлы (totals.deleted). Оба вызывающих
          // (AdminCronService.run() для ручного запуска и
          // CronJobsService.runAndLog() для настоящего Vercel Cron, см.
          // Д-4.3 этапа 71) кладут `error.message` в `summary`/
          // `errorMessage` как есть — обогащаем само сообщение частичным
          // итогом здесь, а не дублируем это в обоих вызывающих.
          throw new Error(
            `${message} (частично выполнено до сбоя: просмотрено ${totals.scanned}, удалено ${totals.deleted} из ${totals.planned} запланированных)`,
          );
        }

        const ids = [
          ...new Set(
            page.blobs
              .map((b) => ownerIdOf(b.pathname, scope))
              .filter((id): id is string => !!id),
          ),
        ];
        const live = ids.length > 0 ? await this.liveOwners(scope, ids) : [];
        const plan = orphanSweepPlan(
          page.blobs,
          live,
          now,
          hours * 60 * 60 * 1000,
          scope,
        );

        let deletedHere = 0;
        if (!isDryRun && plan.delete.length > 0) {
          try {
            deletedHere = await this.blobService.deleteMany(plan.delete);
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            this.logger.error(
              `Метла нашла ${plan.delete.length} осиротевших файлов (${SWEEP_PREFIX[scope]}), но не смогла их удалить: ${message}`,
            );
            // Д-2.3, см. комментарий у соседнего catch (listByPrefix)
            // выше — тот же приём, здесь ещё важнее: именно на ЭТОМ шаге
            // (deleteMany) totals.deleted мог уже вырасти на прошлых
            // страницах перед сбойной.
            throw new Error(
              `${message} (частично выполнено до сбоя: просмотрено ${totals.scanned}, удалено ${totals.deleted} из ${totals.planned} запланированных)`,
            );
          }
        }

        totals.scanned += page.blobs.length;
        totals.deleted += deletedHere;
        totals.planned += plan.delete.length;
        totals.orphanOwners += plan.orphanOwners;
        totals.skippedTooNew += plan.skippedTooNew;
        totals.skippedUnknown += plan.skippedUnknown;
        for (const [kind, n] of Object.entries(plan.byKind)) {
          byKind[kind] = (byKind[kind] ?? 0) + n;
        }
        pagesUsed += 1;
        byScope[scope].scanned += page.blobs.length;
        byScope[scope].orphans += plan.orphanOwners;
        byScope[scope].pages += 1;
        if (
          plan.oldestUploadedAt &&
          (!oldestUploadedAt || plan.oldestUploadedAt < oldestUploadedAt)
        ) {
          oldestUploadedAt = plan.oldestUploadedAt;
        }
        if (scope === 'sessions') {
          orphanSessions += plan.orphanOwners;
          sessionsCursor = page.cursor;
        }
        if (!page.cursor) {
          byScope[scope].complete = true;
          break;
        }
        pageCursor = page.cursor;
      }
      if (!byScope[scope].complete) break;
    }
    const kinds = Object.entries(byKind)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${k}=${n}`)
      .join(', ');
    const scopes = Object.entries(byScope)
      .map(([s, v]) => `${s} ${v.scanned}/${v.orphans}`)
      .join(', ');
    this.logger.log(
      `Метла${isDryRun ? ' (dry run)' : ''}: просмотрено ${totals.scanned} (${scopes}), ` +
        `сирот-владельцев ${totals.orphanOwners}, файлов под удаление ${totals.planned}` +
        `${kinds ? ` (${kinds})` : ''}, удалено ${totals.deleted}, ` +
        `пропущено свежих ${totals.skippedTooNew}, неопознанных путей ${totals.skippedUnknown}` +
        `${oldestUploadedAt ? `, самый старый файл от ${oldestUploadedAt}` : ''}` +
        `${complete ? '' : ' — НЕ досмотрено до конца, остаток следующим прогоном'}`,
    );
    return {
      scanned: totals.scanned,
      orphanSessions,
      orphanOwners: totals.orphanOwners,
      deleted: isDryRun ? totals.planned : totals.deleted,
      byKind,
      byScope,
      oldestUploadedAt,
      skippedTooNew: totals.skippedTooNew,
      skippedUnknown: totals.skippedUnknown,
      dryRun: isDryRun,
      complete,
      cursor: complete ? null : sessionsCursor,
    };
  }

  /**
   * Кто из встреченных в путях владельцев ещё жив. Одна выборка на
   * область, по первичному ключу — то есть по индексу.
   */
  private async liveOwners(
    scope: SweepScope,
    ids: string[],
  ): Promise<string[]> {
    const where = { id: { in: ids } };
    const select = { id: true };
    const rows: Array<{ id: string }> =
      scope === 'sessions'
        ? await this.prisma.session.findMany({ where, select })
        : scope === 'projects'
          ? await this.prisma.project.findMany({ where, select })
          : scope === 'brand-manifests'
            ? await this.prisma.brandManifest.findMany({ where, select })
            : scope === 'publications'
              ? await this.prisma.publicationRequest.findMany({ where, select })
              : scope === 'shared-videos'
                ? await this.prisma.sharedVideoPage.findMany({ where, select })
                : // 'users' (Е-5.2 шестого аудита, этап 76) — владелец
                  // `users/<userId>/voices/…` — сама таблица users.
                  await this.prisma.user.findMany({ where, select });
    return rows.map((r) => r.id);
  }
}
