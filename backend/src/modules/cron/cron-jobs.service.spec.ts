/**
 * Этап 69: логика десяти крон-задач переехала из `CronController` в
 * `CronJobsService` (extract-method, без смены поведения — см.
 * доккомментарий на классе). Эти тесты — перенос существующих тестов
 * `CronController` (до этапа 69) на новые имена методов; секрет здесь
 * больше не проверяется (это теперь исключительно забота
 * `CronController`/`AdminCronController` — см. `cron.controller.spec.ts`
 * и `admin-cron.service.spec.ts`), поэтому все ассерты — про саму
 * бизнес-логику: партии/бюджет уборки, dryRun метлы, четыре области
 * метлы, содержимое суточного отчёта, делегирование продления подписок.
 *
 * Оба маршрута удаляют файлы из Blob НЕОБРАТИМО — эти тесты и раньше
 * существовали ради этого (не «работает ли крон», а «удаляет ли он
 * ровно то, что должен, и ничего сверх»).
 */

jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
// Эти четыре сервиса рантайм-импортируют перечисления из `@prisma/client`
// (BlogPostStatus и т.п.) — при `isolatedModules: true` (см.
// doc/PRODUCT-PROJECT-IMPLEMENTATION-PLAN.md, этап 67/68) TS не может
// стереть такой импорт как чисто типовой, и require реального
// `@prisma/client` в песочнице падает («Cannot find module
// '.prisma/client/default'», клиент не сгенерирован). Мокаем модули
// целиком — их поведение здесь не тестируется, конструктор
// CronJobsService должен просто собраться.
jest.mock('../../common/session.service', () => ({ SessionService: class {} }));
jest.mock('../admin-panel/admin-panel.service', () => ({
  AdminPanelService: class {},
}));
jest.mock('../blog/blog-generation.service', () => ({
  BlogGenerationService: class {},
}));
jest.mock('../blog/blog-translation.service', () => ({
  BlogTranslationService: class {},
}));
// `feedImportWorker` (ProductFeedImportWorkerService) напрямую
// импортирует `ProjectService` (переиспользует `addItem()`, этап 68), а
// тот тоже рантайм-импортирует `Prisma` из `@prisma/client` — тот же
// приём, что понадобился `product-feed-import-worker.service.spec.ts`
// (см. doc/PRODUCT-PROJECT-IMPLEMENTATION-PLAN.md, этап 68). Этап 89:
// `CronJobsService` теперь и сам импортирует `ProjectService` напрямую
// (`purgeSoftDeletedProjects`/`purgeSoftDeletedItems`) — тот же мок,
// второй причины мокать его больше не требуется.
jest.mock('../project/project.service', () => ({ ProjectService: class {} }));
// `catalogBatchWorker`/`abTestWorker` (этапы 65/66) рантайм-используют
// `WorkflowKind.CATALOG_BATCH_ITEM`/`WorkflowKind.AB_TEST_VARIANT` —
// тот же класс проблемы, что у четырёх сервисов выше, просто не
// заведённый в мок вовремя (эти тесты в этой песочнице не запускали с
// этапа 65/66 до этапа 89 — см. doc/CI.md).
jest.mock('../catalog-batch/catalog-batch-worker.service', () => ({
  CatalogBatchWorkerService: class {},
}));
jest.mock('../ab-test/ab-test-worker.service', () => ({
  AbTestWorkerService: class {},
}));

// Уборка снимков интерфейса — настоящая функция по умолчанию; тесты
// ниже подменяют её результат, чтобы проверить проводку счётчиков в
// отчёт крона (её собственные правила — `ui-snapshot-retention.spec.ts`).
jest.mock('../ui-snapshot/ui-snapshot-retention', () => {
  const actual = jest.requireActual('../ui-snapshot/ui-snapshot-retention');
  return {
    ...actual,
    pruneUiSnapshots: jest.fn(
      (...args: Parameters<typeof actual.pruneUiSnapshots>) =>
        actual.pruneUiSnapshots(...args),
    ),
  };
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CronJobsService,
  VERCEL_CRON_TRIGGERED_BY,
  CRON_LOG_RETENTION_DAYS,
} from './cron-jobs.service';

const HOUR = 60 * 60 * 1000;
/** Старше суточного порога — иначе метла пропустит файл как свежий. */
const old = () => new Date(Date.now() - 48 * HOUR);

function build() {
  const sessionService = {
    cleanupExpiredSessions: jest.fn().mockResolvedValue({
      count: 2,
      blobPathnames: ['sessions/dead/generated.mp4'],
      hasMore: false,
    }),
    // Этап 89 — по умолчанию нечего физически убирать (грейс-период
    // никто не прошёл); тесты, которым нужен непустой прогон, сами
    // переопределяют мок.
    purgeSoftDeletedSessions: jest
      .fn()
      .mockResolvedValue({ count: 0, blobPathnames: [], hasMore: false }),
  };
  // Этап 89: `CronJobsService` зовёт `purgeSoftDeletedProjects`/
  // `purgeSoftDeletedItems` из того же суточного прогона — см.
  // `runCleanupSessions`.
  const projectService = {
    purgeSoftDeletedProjects: jest
      .fn()
      .mockResolvedValue({ count: 0, hasMore: false }),
    purgeSoftDeletedItems: jest
      .fn()
      .mockResolvedValue({ count: 0, hasMore: false }),
  };
  const prisma = {
    adminSession: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    userSession: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    // Этап 140: короткие входы через Google убираются тем же прогоном.
    youtubeUnlockSession: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    session: { findMany: jest.fn().mockResolvedValue([]) },
    // Этап 41: метла ходит по нескольким префиксам, у каждого своя таблица.
    project: { findMany: jest.fn().mockResolvedValue([]) },
    brandManifest: { findMany: jest.fn().mockResolvedValue([]) },
    publicationRequest: { findMany: jest.fn().mockResolvedValue([]) },
    sharedVideoPage: { findMany: jest.fn().mockResolvedValue([]) },
    // Е-5.2 шестого аудита, этап 76: users/ — пятая область метлы.
    user: { findMany: jest.fn().mockResolvedValue([]) },
    // М-3.9 седьмого аудита: джоб-замок у blog / export-sync-run.
    cronJobLock: {
      create: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    // Пятый аудит, Д-4.3: `runAndLog` пишет строку CronRunLog вокруг
    // прогона настоящего Vercel Cron.
    cronRunLog: {
      create: jest.fn().mockResolvedValue({ id: 'run-log-1' }),
      update: jest.fn().mockResolvedValue(undefined),
      // Ретенция журнала (аудит 27.09.2026) — в суточной уборке.
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    // Срок хранения снимков интерфейса — по умолчанию убирать нечего.
    uiSnapshot: {
      groupBy: jest.fn().mockResolvedValue([]),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  };
  /** Листинг отвечает по префиксу — как настоящее хранилище. */
  const byPrefix: Record<
    string,
    Array<{ pathname: string; uploadedAt: Date }>
  > = {
    'sessions/': [
      { pathname: 'sessions/dead/generated.mp4', uploadedAt: old() },
      { pathname: 'sessions/dead/previews/scene-s1.jpg', uploadedAt: old() },
    ],
    'projects/': [],
    'brand-manifests/': [],
    'publications/': [],
  };
  const blobService = {
    deleteMany: jest.fn().mockResolvedValue(1),
    listByPrefix: jest
      .fn()
      .mockImplementation((prefix: string) =>
        Promise.resolve({ blobs: byPrefix[prefix] ?? [], cursor: null }),
      ),
  };
  const notify = {
    alert: jest.fn().mockResolvedValue(true),
    stat: jest.fn().mockResolvedValue(true),
    report: jest.fn().mockResolvedValue(true),
    pruneStates: jest.fn().mockResolvedValue(0),
    suppressedSummary: jest.fn().mockResolvedValue([]),
  };
  const aiUsage = {
    report: jest.fn().mockResolvedValue({
      last24hMicroUsd: 1_500_000,
      last7dMicroUsd: 9_000_000,
      totalMicroUsd: 42_000_000,
      anonymousMicroUsd: 500_000,
      anonymousSpentTodayMicroUsd: 120_000,
      unpricedCalls: 3,
      payingUsers: 12,
      sessionsWithCost: 40,
    }),
  };
  const adminPanel = {
    getTelemetry: jest.fn().mockResolvedValue({
      total: 300,
      byStatus: { video_complete: 200, error: 30 },
      createdLast24h: 25,
      createdLast7d: 140,
      failedGenerations: 7,
    }),
  };
  const library = {
    pruneUnused: jest
      .fn()
      .mockResolvedValue({ count: 3, hasMore: false, disabled: false }),
  };
  const blogGeneration = {
    runDailyGeneration: jest.fn().mockResolvedValue({
      categoriesTried: 0,
      candidatesConsidered: 0,
      draftsCreated: 0,
      skippedBudget: false,
    }),
    // Этап 95: третий шаг /api/cron/blog — тот же приём делегирования.
    runCoverImageBackfill: jest.fn().mockResolvedValue({
      candidates: 0,
      uploaded: 0,
      stillFallback: 0,
    }),
  };
  const blogTranslation = {
    runTranslationCron: jest.fn().mockResolvedValue({
      polledJobs: 0,
      completedJobs: 0,
      translationsEnsured: 0,
      submittedBatch: 'not-configured',
    }),
  };
  const publishWorker = {
    runBatch: jest.fn().mockResolvedValue({
      processed: 0,
      published: 0,
      failed: 0,
      stillPending: 0,
    }),
  };
  const billingRenewal = {
    runBatch: jest.fn().mockResolvedValue({
      processed: 0,
      renewed: 0,
      canceled: 0,
      pastDue: 0,
    }),
  };
  const marketingBroadcast = {
    runDaily: jest.fn().mockResolvedValue({
      composed: false,
      featured: 0,
      recipients: 0,
      processed: 0,
      sent: 0,
      skipped: 0,
      failed: 0,
      stillPending: 0,
    }),
  };
  const catalogBatchWorker = {
    runBatch: jest.fn().mockResolvedValue({
      processed: 0,
      started: 0,
      failed: 0,
      stillPending: 0,
    }),
  };
  const abTestWorker = {
    runBatch: jest.fn().mockResolvedValue({
      processed: 0,
      started: 0,
      failed: 0,
      stillPending: 0,
    }),
  };
  const feedImportWorker = {
    runTick: jest.fn().mockResolvedValue({
      claimedRuns: 0,
      fetchedRuns: 0,
      failedRuns: 0,
      claimedItems: 0,
      importedItems: 0,
      skippedItems: 0,
      failedItems: 0,
    }),
  };
  // Е-2.3 шестого аудита, этап 76: крон-аналог advanceGenerating для
  // автоэкспорта яруса B — тот же приём делегирования, что у остальных
  // воркеров выше.
  const exportService = {
    runSyncTick: jest.fn().mockResolvedValue({ checked: 0, failed: 0 }),
  };
  // Этап 94: генератор сценариев для будущей автозаписи обучающих видео —
  // тот же приём делегирования, что у остальных воркеров выше.
  const tutorialScenarioGenerator = {
    run: jest.fn().mockResolvedValue({
      subjectKeys: 10,
      generated: 10,
      costly: 0,
      failed: 0,
      failures: [],
    }),
  };
  // Этап 96: исполнитель уже сгенерированных сценариев — тот же приём
  // делегирования, что у tutorialScenarioGenerator выше.
  const tutorialScenarioRunner = {
    run: jest.fn().mockResolvedValue({
      total: 0,
      passed: 0,
      failed: 0,
      outcomes: [],
    }),
    // Сквозной аудит 27.09.2026 (Д-2): опрос только сборок слайд-шоу,
    // без браузера.
    pollAssemblies: jest.fn().mockResolvedValue({ polled: 0, pending: 0 }),
  };
  // Этап 100: крон-обход интерфейса TMA (§3 ТЗ) — тот же приём
  // делегирования, что у tutorialScenarioRunner выше.
  const uiSnapshotRunner = {
    run: jest.fn().mockResolvedValue({
      total: 0,
      changed: 0,
      failed: 0,
      outcomes: [],
    }),
  };
  // Уборка ИИ-скетчей — отдельный шаг того же суточного прогона
  // (§6.7 ТЗ скетча); в тестах уборки сессий она ничего не делает.
  const imageSketch = {
    runCleanupTick: jest.fn().mockResolvedValue({ expired: 0, purged: 0 }),
  };
  // Джобы маркетплейса и живого эфира (auction-close/assess/
  // google-ads-sync, live-auction-tick, portfolio-watermark) — их не
  // было в этом моке, хотя в сервисе они уже объявлены.
  const auctionService = {
    closeExpiredListings: jest.fn().mockResolvedValue({ closed: 0 }),
    reconcileGoogleAdsCampaigns: jest
      .fn()
      .mockResolvedValue({ paused: 0, stillStuck: 0 }),
  };
  const auctionAiAssessment = {
    runTick: jest.fn().mockResolvedValue({ assessed: false }),
  };
  const liveAuctionOrchestrator = {
    collapseInactiveStreams: jest
      .fn()
      .mockResolvedValue({ collapsed: 0, reapedStalePendingCues: 0 }),
  };
  const portfolioWatermark = {
    runTick: jest.fn().mockResolvedValue({ processed: 0, failed: 0 }),
  };
  // Заявки внешнего API на ролик (этап 145).
  const apiVideo = {
    runTick: jest.fn().mockResolvedValue({
      started: 0,
      completed: 0,
      failed: 0,
      running: 0,
      delivered: 0,
      retried: 0,
      gaveUp: 0,
    }),
  };
  // Сторож остатков у провайдеров (этап 143).
  const balances = {
    watch: jest.fn().mockResolvedValue({
      watched: 2,
      low: 0,
      unreadable: 0,
      notified: 0,
      skippedUnused: 1,
    }),
  };

  // Уборка необработанных голосовых записей (финальный аудит ветки K).
  const voiceUploads = {
    sweepExpired: jest
      .fn()
      .mockResolvedValue({ deleted: 0, failed: 0, hasMore: false }),
  };

  // Срок хранения селфи персоны (этап E Greeting 2.0, В-3).
  const personas = {
    purgeExpiredSources: jest
      .fn()
      .mockResolvedValue({ purged: 0, abandoned: 0, failed: 0 }),
  };

  const service = new CronJobsService(
    sessionService as never,
    projectService as never,
    prisma as never,
    blobService as never,
    notify as never,
    aiUsage as never,
    adminPanel as never,
    library as never,
    blogGeneration as never,
    blogTranslation as never,
    publishWorker as never,
    billingRenewal as never,
    marketingBroadcast as never,
    catalogBatchWorker as never,
    abTestWorker as never,
    feedImportWorker as never,
    exportService as never,
    tutorialScenarioGenerator as never,
    tutorialScenarioRunner as never,
    uiSnapshotRunner as never,
    imageSketch as never,
    auctionService as never,
    auctionAiAssessment as never,
    liveAuctionOrchestrator as never,
    portfolioWatermark as never,
    balances as never,
    apiVideo as never,
    voiceUploads as never,
    personas as never,
  );
  return {
    service,
    voiceUploads,
    personas,
    library,
    sessionService,
    auctionService,
    auctionAiAssessment,
    liveAuctionOrchestrator,
    portfolioWatermark,
    balances,
    apiVideo,
    projectService,
    prisma,
    blobService,
    byPrefix,
    notify,
    aiUsage,
    adminPanel,
    billingRenewal,
    marketingBroadcast,
    exportService,
    tutorialScenarioGenerator,
    tutorialScenarioRunner,
    uiSnapshotRunner,
    blogGeneration,
    blogTranslation,
  };
}

describe('CronJobsService — уборка сессий партиями', () => {
  it('уборка удаляет сессии и их файлы', async () => {
    const { service, blobService } = build();
    const result = await service.runCleanupSessions();
    expect(result.deletedCount).toBe(2);
    expect(blobService.deleteMany).toHaveBeenCalledWith([
      'sessions/dead/generated.mp4',
    ]);
  });

  it('уборка идёт партиями до конца, а не одной (этап 40, А-1.5)', async () => {
    const { service, sessionService } = build();
    sessionService.cleanupExpiredSessions
      .mockResolvedValueOnce({
        count: 500,
        blobPathnames: ['sessions/a/generated.mp4'],
        hasMore: true,
      })
      .mockResolvedValueOnce({
        count: 500,
        blobPathnames: ['sessions/b/generated.mp4'],
        hasMore: true,
      })
      .mockResolvedValueOnce({
        count: 7,
        blobPathnames: ['sessions/c/generated.mp4'],
        hasMore: false,
      });

    const result = await service.runCleanupSessions();

    expect(sessionService.cleanupExpiredSessions).toHaveBeenCalledTimes(3);
    expect(result.deletedCount).toBe(1007);
    expect(result.hasMoreSessions).toBe(false);
  });

  it('бесконечная очередь не держит крон до его смерти', async () => {
    const { service, sessionService } = build();
    sessionService.cleanupExpiredSessions.mockResolvedValue({
      count: 500,
      blobPathnames: [],
      hasMore: true,
    });
    const { CLEANUP_MAX_PASSES } = await import('./cron-jobs.service');

    const result = await service.runCleanupSessions();

    expect(sessionService.cleanupExpiredSessions).toHaveBeenCalledTimes(
      CLEANUP_MAX_PASSES,
    );
    expect(result.hasMoreSessions).toBe(true);
  });

  it('второй предохранитель — время: партии останавливаются по бюджету (В-6.9)', async () => {
    const { service, sessionService } = build();
    sessionService.cleanupExpiredSessions.mockResolvedValue({
      count: 500,
      blobPathnames: [],
      hasMore: true,
    });
    const { CLEANUP_TIME_BUDGET_MS } = await import('./cron-jobs.service');
    const realNow = Date.now;
    let calls = 0;
    // Джоб-замок (этап 89, доп. аудит): `tryAcquireJobLock` теперь тоже
    // читает `Date.now()` (для `lockedUntil`) ДО того, как сам прогон
    // засечёт свой `started` — на один вызов раньше, чем было до замка.
    // Первые ДВА вызова — замок и `started` — возвращают одно и то же
    // «сейчас»; с третьего вызова (первая проверка бюджета в цикле) —
    // время, уже вышедшее за бюджет.
    Date.now = () => {
      calls += 1;
      return calls <= 2 ? 1_000_000 : 1_000_000 + CLEANUP_TIME_BUDGET_MS + 1;
    };
    try {
      const result = await service.runCleanupSessions();
      expect(sessionService.cleanupExpiredSessions).toHaveBeenCalledTimes(1);
      expect(result.hasMoreSessions).toBe(true);
    } finally {
      Date.now = realNow;
    }
  });

  // Найдено доп. аудитом (MEDIUM): метод зовётся и суточным расписанием, и
  // ручной кнопкой админки (admin-cron.service.ts) — тот же риск двойного
  // прогона, что уже обосновал джоб-замок у runBlog/runExportSyncRun (см.
  // доккомментарий runCleanupSessions).
  it('ретенция журнала кронов: строки старше месяца удаляются тем же прогоном', async () => {
    // Таблица росла без предела: каждый двухминутный джоб пишет ~720
    // строк в сутки, и `tutorial-assembly-poll` (27.09.2026) добавился
    // к ним ещё одним. Отдельный крон ради одного `deleteMany` не
    // нужен — тот же довод, что у уборки ИИ-скетчей рядом.
    const { service, prisma } = build();
    prisma.cronRunLog.deleteMany.mockResolvedValue({ count: 42 });

    const result = await service.runCleanupSessions();

    const [[arg]] = prisma.cronRunLog.deleteMany.mock.calls as [
      [{ where: { startedAt: { lt: Date } } }],
    ];
    const days = (Date.now() - arg.where.startedAt.lt.getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(CRON_LOG_RETENTION_DAYS);
    expect(result.deletedCronLogs).toBe(42);
  });

  it('сбой чистки журнала не роняет уборку сессий', async () => {
    // Best-effort, как и уборка скетчей: джоб существует ради сессий.
    const { service, prisma } = build();
    prisma.cronRunLog.deleteMany.mockRejectedValue(new Error('база лежит'));

    const result = await service.runCleanupSessions();

    expect(result.deletedCronLogs).toBe(0);
    expect(result.deletedCount).toBeGreaterThanOrEqual(0);
  });

  it('джоб-замок: второй прогон поверх уже идущего — пропуск, ничего не тронуто', async () => {
    const { service, sessionService, projectService, blobService, prisma } =
      build();
    prisma.cronJobLock.create.mockRejectedValue(
      Object.assign(new Error('unique constraint'), { code: 'P2002' }),
    );
    prisma.cronJobLock.updateMany.mockResolvedValue({ count: 0 });

    const result = await service.runCleanupSessions();

    expect(result).toEqual({
      deletedCronLogs: 0,
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
      deletedUiSnapshots: 0,
      deletedUiSnapshotBlobs: 0,
      uiSnapshotCleanupFailed: 0,
      hasMoreUiSnapshots: false,
      uiSnapshotCleanupPages: 0,
      uiSnapshotCleanupMs: 0,
      skipped: true,
    });
    expect(prisma.uiSnapshot.groupBy).not.toHaveBeenCalled();
    expect(sessionService.cleanupExpiredSessions).not.toHaveBeenCalled();
    expect(projectService.purgeSoftDeletedProjects).not.toHaveBeenCalled();
    expect(blobService.deleteMany).not.toHaveBeenCalled();
  });
});

/**
 * Этап 89: тот же суточный прогон (`runCleanupSessions`) физически убирает
 * Project/ProductItem/Session, мягко удалённые дольше грейс-периода — не
 * отдельный крон-джоб (см. доккомментарий метода). Партии/бюджет — тот же
 * приём, что уже проверен выше для TTL-уборки сессий.
 */
describe('CronJobsService — физическая уборка мягко удалённых Project/ProductItem/Session (этап 89)', () => {
  it('зовёт все три purge-метода и суммирует их счётчики в результате', async () => {
    const { service, sessionService, projectService } = build();
    sessionService.purgeSoftDeletedSessions.mockResolvedValue({
      count: 3,
      blobPathnames: ['sessions/soft/generated.mp4'],
      hasMore: false,
    });
    projectService.purgeSoftDeletedProjects.mockResolvedValue({
      count: 1,
      hasMore: false,
    });
    projectService.purgeSoftDeletedItems.mockResolvedValue({
      count: 2,
      hasMore: false,
    });

    const result = await service.runCleanupSessions();

    expect(result.purgedSoftDeletedSessions).toBe(3);
    expect(result.purgedSoftDeletedProjects).toBe(1);
    expect(result.purgedSoftDeletedItems).toBe(2);
    expect(result.hasMoreSoftDeleted).toBe(false);
  });

  it('пути файлов мягко удалённых сессий уходят в ТОТ ЖЕ deleteMany, что и TTL-уборка', async () => {
    // Project/ProductItem чистят свои файлы сами (ProjectService уже
    // держит BlobService) — сюда попадают только пути сессий.
    const { service, sessionService, blobService } = build();
    sessionService.purgeSoftDeletedSessions.mockResolvedValue({
      count: 1,
      blobPathnames: ['sessions/soft/generated.mp4'],
      hasMore: false,
    });

    await service.runCleanupSessions();

    expect(blobService.deleteMany).toHaveBeenCalledWith(
      expect.arrayContaining([
        'sessions/dead/generated.mp4',
        'sessions/soft/generated.mp4',
      ]),
    );
  });

  it('items доедает свою очередь партиями, независимо от sessions/projects (уже пустых)', async () => {
    const { service, projectService } = build();
    projectService.purgeSoftDeletedItems
      .mockResolvedValueOnce({ count: 500, hasMore: true })
      .mockResolvedValueOnce({ count: 500, hasMore: true })
      .mockResolvedValueOnce({ count: 7, hasMore: false });

    const result = await service.runCleanupSessions();

    expect(projectService.purgeSoftDeletedItems).toHaveBeenCalledTimes(3);
    expect(result.purgedSoftDeletedItems).toBe(1007);
    expect(result.hasMoreSoftDeleted).toBe(false);
  });

  it('hasMoreSoftDeleted — true, когда партий/бюджета не хватило на весь остаток', async () => {
    const { service, projectService } = build();
    projectService.purgeSoftDeletedProjects.mockResolvedValue({
      count: 500,
      hasMore: true,
    });
    const { CLEANUP_MAX_PASSES } = await import('./cron-jobs.service');

    const result = await service.runCleanupSessions();

    expect(projectService.purgeSoftDeletedProjects).toHaveBeenCalledTimes(
      CLEANUP_MAX_PASSES,
    );
    expect(result.hasMoreSoftDeleted).toBe(true);
  });

  it('нечего чистить — покой: purge зовётся по одному разу каждый, счётчики нулевые', async () => {
    const { service, sessionService, projectService } = build();
    const result = await service.runCleanupSessions();
    expect(sessionService.purgeSoftDeletedSessions).toHaveBeenCalledTimes(1);
    expect(projectService.purgeSoftDeletedProjects).toHaveBeenCalledTimes(1);
    expect(projectService.purgeSoftDeletedItems).toHaveBeenCalledTimes(1);
    expect(result.purgedSoftDeletedSessions).toBe(0);
    expect(result.purgedSoftDeletedProjects).toBe(0);
    expect(result.purgedSoftDeletedItems).toBe(0);
  });
});

describe('CronJobsService — dryRun у метлы ничего не удаляет', () => {
  it('dryRun=1: список показан, файлы на месте', async () => {
    const { service, blobService } = build();

    const result = await service.runSweepOrphans({ dryRun: '1' });

    expect(blobService.deleteMany).not.toHaveBeenCalled();
    expect(result.dryRun).toBe(true);
    expect(result.deleted).toBe(2);
    expect(result.orphanSessions).toBe(1);
  });

  it('dryRun=true — то же самое: параметр приходит строкой', async () => {
    const { service, blobService } = build();
    const result = await service.runSweepOrphans({ dryRun: 'true' });
    expect(blobService.deleteMany).not.toHaveBeenCalled();
    expect(result.dryRun).toBe(true);
  });

  it('без dryRun те же файлы действительно удаляются', async () => {
    const { service, blobService } = build();
    blobService.deleteMany.mockResolvedValue(2);

    const result = await service.runSweepOrphans({});

    expect(blobService.deleteMany).toHaveBeenCalledWith([
      'sessions/dead/generated.mp4',
      'sessions/dead/previews/scene-s1.jpg',
    ]);
    expect(result.dryRun).toBe(false);
    expect(result.deleted).toBe(2);
  });

  it('живая сессия не подметается, даже если её файлы старые', async () => {
    const { service, prisma, blobService } = build();
    prisma.session.findMany.mockResolvedValue([{ id: 'dead' }]);

    const result = await service.runSweepOrphans({});

    expect(blobService.deleteMany).not.toHaveBeenCalled();
    expect(result.orphanSessions).toBe(0);
  });
});

describe('CronJobsService — метла ходит по пяти префиксам (плюс sessions)', () => {
  it('файлы удалённого пользователя подметаются, живые не трогаются', async () => {
    const { service, prisma, blobService, byPrefix } = build();
    byPrefix['sessions/'] = [];
    byPrefix['projects/'] = [
      { pathname: 'projects/live/items/i1/photo.jpg', uploadedAt: old() },
      { pathname: 'projects/dead/items/i1/photo.jpg', uploadedAt: old() },
      {
        pathname: 'projects/dead/items/i1/voice-1757000000000.webm',
        uploadedAt: old(),
      },
    ];
    byPrefix['brand-manifests/'] = [
      { pathname: 'brand-manifests/dead/characters/c1.jpg', uploadedAt: old() },
    ];
    byPrefix['publications/'] = [
      { pathname: 'publications/gone/video.mp4', uploadedAt: old() },
    ];
    prisma.project.findMany.mockResolvedValue([{ id: 'live' }]);
    blobService.deleteMany.mockResolvedValue(1);

    const result = await service.runSweepOrphans({});

    expect(blobService.deleteMany).toHaveBeenCalledWith([
      'projects/dead/items/i1/photo.jpg',
      'projects/dead/items/i1/voice-1757000000000.webm',
    ]);
    expect(blobService.deleteMany).toHaveBeenCalledWith([
      'brand-manifests/dead/characters/c1.jpg',
    ]);
    expect(blobService.deleteMany).toHaveBeenCalledWith([
      'publications/gone/video.mp4',
    ]);
    expect(result.byScope).toMatchObject({
      projects: { scanned: 3, orphans: 1 },
      'brand-manifests': { scanned: 1, orphans: 1 },
      publications: { scanned: 1, orphans: 1 },
    });
    expect(result.byKind).toMatchObject({
      photo: 1,
      voice: 1,
      characters: 1,
      video: 1,
    });
    expect(result.orphanOwners).toBe(3);
  });

  it('живая заявка свою копию не теряет', async () => {
    const { service, prisma, blobService, byPrefix } = build();
    byPrefix['sessions/'] = [];
    byPrefix['publications/'] = [
      { pathname: 'publications/open/video.mp4', uploadedAt: old() },
    ];
    prisma.publicationRequest.findMany.mockResolvedValue([{ id: 'open' }]);

    const result = await service.runSweepOrphans({});

    expect(blobService.deleteMany).not.toHaveBeenCalled();
    expect(result.deleted).toBe(0);
  });

  it('Е-5.2 шестого аудита: сирота под users/ (незавершённое клонирование голоса) подметается, живой пользователь — нет', async () => {
    const { service, prisma, blobService, byPrefix } = build();
    byPrefix['sessions/'] = [];
    byPrefix['users/'] = [
      {
        pathname: 'users/dead/voices/v1/sample.webm',
        uploadedAt: old(),
      },
      {
        pathname: 'users/live/voices/v2/sample.webm',
        uploadedAt: old(),
      },
    ];
    prisma.user.findMany.mockResolvedValue([{ id: 'live' }]);
    blobService.deleteMany.mockResolvedValue(1);

    const result = await service.runSweepOrphans({});

    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: { id: { in: expect.arrayContaining(['dead', 'live']) } },
      select: { id: true },
    });
    expect(blobService.deleteMany).toHaveBeenCalledWith([
      'users/dead/voices/v1/sample.webm',
    ]);
    expect(result.byKind).toMatchObject({ voice: 1 });
  });

  it('постеры роликов обучалки: живой ролик — постер на месте, удалённый — постер подметается (06.10.2026)', async () => {
    const { service, prisma, blobService, byPrefix } = build();
    byPrefix['sessions/'] = [];
    byPrefix['tutorial-video-posters/'] = [
      { pathname: 'tutorial-video-posters/tva-live.png', uploadedAt: old() },
      { pathname: 'tutorial-video-posters/tva-gone.png', uploadedAt: old() },
    ];
    const p = prisma as unknown as Record<string, Record<string, jest.Mock>>;
    p.tutorialVideoAsset = {
      ...(p.tutorialVideoAsset ?? {}),
      findMany: jest.fn().mockResolvedValue([{ id: 'tva-live' }]),
    };
    blobService.deleteMany.mockResolvedValue(1);

    const result = await service.runSweepOrphans({});

    expect(p.tutorialVideoAsset.findMany).toHaveBeenCalledWith({
      where: { id: { in: expect.arrayContaining(['tva-live', 'tva-gone']) } },
      select: { id: true },
    });
    expect(blobService.deleteMany).toHaveBeenCalledWith([
      'tutorial-video-posters/tva-gone.png',
    ]);
    expect(result.byScope['tutorial-video-posters']).toMatchObject({
      scanned: 2,
      orphans: 1,
    });
  });

  it('dryRun считает файлы всех областей и не удаляет ничего', async () => {
    const { service, blobService, byPrefix } = build();
    byPrefix['projects/'] = [
      { pathname: 'projects/dead/items/i1/photo.jpg', uploadedAt: old() },
    ];

    const result = await service.runSweepOrphans({ dryRun: '1' });

    expect(blobService.deleteMany).not.toHaveBeenCalled();
    expect(result.deleted).toBe(3);
  });

  it('Д-2.3: провал deleteMany ПОСЛЕ реального частичного удаления — сообщение об ошибке несёт уже сделанный итог, не только текст сбоя', async () => {
    const { service, blobService, byPrefix } = build();
    // 'sessions' (первая область по порядку SWEEP_SCOPES) удаляет
    // успешно — 1 файл (штатный byPrefix из build()); 'projects' —
    // вторая область — падает на deleteMany.
    byPrefix['projects/'] = [
      { pathname: 'projects/dead/items/i1/photo.jpg', uploadedAt: old() },
    ];
    blobService.deleteMany
      .mockResolvedValueOnce(1) // sessions — успех
      .mockRejectedValueOnce(new Error('blob down')); // projects — сбой

    await expect(service.runSweepOrphans({})).rejects.toThrow(
      /blob down.*частично выполнено до сбоя.*удалено 1 из 2 запланированных/s,
    );
  });
});

describe('CronJobsService — отчёт в канал статистики', () => {
  it('в отчёте есть сессии, провалы, расход и воронка по статусам', async () => {
    const { service, notify } = build();

    const res = await service.runReport();

    expect(notify.report).toHaveBeenCalledTimes(1);
    const text = notify.report.mock.calls[0][0] as string;
    expect(text).toContain('Сессий всего: 300');
    expect(text).toContain('за сутки: 25');
    expect(text).toContain('Провалов генерации: 7');
    expect(text).toContain('$1.50');
    expect(text).toContain('video_complete=200');
    expect(res.sent).toBe(true);
  });

  it('отчёт возвращает тот же текст, что ушёл в канал', async () => {
    const { service, notify } = build();
    const res = await service.runReport();
    expect(res.text).toBe(notify.report.mock.calls[0][0]);
  });

  it('sent отражает ответ канала, а не факт постановки в очередь (этап 47)', async () => {
    const { service, notify } = build();
    notify.report.mockResolvedValueOnce(false);
    const res = await service.runReport();
    expect(res.sent).toBe(false);
  });
});

describe('CronJobsService — крон продления подписок (этап 62)', () => {
  it('делегирует воркеру продления и отдаёт его сводку как есть', async () => {
    const { service, billingRenewal } = build();
    billingRenewal.runBatch.mockResolvedValue({
      processed: 3,
      renewed: 2,
      canceled: 1,
      pastDue: 0,
    });
    const result = await service.runBillingRenew();
    expect(billingRenewal.runBatch).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      processed: 3,
      renewed: 2,
      canceled: 1,
      pastDue: 0,
    });
  });
});

/**
 * Этап 47 (В-2.4): метла идёт до конца курсора, а не смотрит одну
 * страницу.
 */
describe('CronJobsService — метла идёт до конца курсора', () => {
  function buildPaged() {
    const pages: Record<
      string,
      { blobs: { pathname: string; uploadedAt: Date }[]; cursor: string | null }
    > = {
      first: {
        blobs: [
          { pathname: 'projects/p-live/items/i1/photo.png', uploadedAt: old() },
        ],
        cursor: 'c2',
      },
      c2: {
        blobs: [
          { pathname: 'projects/p-live/items/i2/photo.png', uploadedAt: old() },
        ],
        cursor: 'c3',
      },
      c3: {
        blobs: [
          { pathname: 'projects/p-dead/items/i9/photo.png', uploadedAt: old() },
        ],
        cursor: null,
      },
    };
    const listByPrefix = jest.fn((prefix: string, opts: { cursor?: string }) =>
      prefix === 'projects/'
        ? Promise.resolve(pages[opts.cursor ?? 'first'])
        : Promise.resolve({ blobs: [], cursor: null }),
    );
    const blobService = {
      listByPrefix,
      deleteMany: jest.fn((paths: string[]) => Promise.resolve(paths.length)),
    };
    const prisma = {
      session: { findMany: jest.fn().mockResolvedValue([]) },
      project: {
        findMany: jest.fn().mockResolvedValue([{ id: 'p-live' }]),
      },
      brandManifest: { findMany: jest.fn().mockResolvedValue([]) },
      publicationRequest: { findMany: jest.fn().mockResolvedValue([]) },
      sharedVideoPage: { findMany: jest.fn().mockResolvedValue([]) },
    };
    // Уборка ИИ-скетчей — отдельный шаг того же суточного прогона
    // (§6.7 ТЗ скетча); в тестах уборки сессий она ничего не делает.
    const imageSketch = {
      runCleanupTick: jest.fn().mockResolvedValue({ expired: 0, purged: 0 }),
    };
    const service = new CronJobsService(
      {} as never,
      {} as never,
      prisma as never,
      blobService as never,
      {
        pruneStates: jest.fn(),
        suppressedSummary: jest.fn().mockResolvedValue([]),
      } as never,
      {} as never,
      {} as never,
      {
        pruneUnused: jest
          .fn()
          .mockResolvedValue({ count: 0, hasMore: false, disabled: false }),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      imageSketch as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { service, blobService };
  }

  /**
   * У префикса `tutorial-video-frames/` ДВА владельца, и метла обязана
   * знать обоих (аудит собственных правок 29.09.2026).
   *
   * `tutorial-video-frames/<assetId>/` — кадры-транзиты сборки роликов
   * мастера, `tutorial-video-frames/<draftId>/` — кадры обучалки по
   * сайту заказчика. Общий префикс выбран продуктом сознательно
   * (`draft-frames.ts`), а первая редакция метлы знала только первого
   * владельца — и сносила кадры ЖИВЫХ черновиков, пролежавших на
   * модерации дольше порога свежести.
   */
  function buildFramesSweep(live: { assets?: string[]; drafts?: string[] }) {
    const old = () => new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const blobService = {
      listByPrefix: jest.fn((prefix: string) =>
        Promise.resolve(
          prefix === 'tutorial-video-frames/'
            ? {
                blobs: [
                  {
                    pathname: 'tutorial-video-frames/tva-1/0.png',
                    uploadedAt: old(),
                  },
                  {
                    pathname: 'tutorial-video-frames/draft-1/0.jpg',
                    uploadedAt: old(),
                  },
                ],
                cursor: null,
              }
            : { blobs: [], cursor: null },
        ),
      ),
      deleteMany: jest.fn((paths: string[]) => Promise.resolve(paths.length)),
    };
    const none = { findMany: jest.fn().mockResolvedValue([]) };
    const prisma = {
      session: none,
      project: none,
      brandManifest: none,
      publicationRequest: none,
      sharedVideoPage: none,
      user: none,
      tutorialVideoAsset: {
        findMany: jest
          .fn()
          .mockResolvedValue((live.assets ?? []).map((id) => ({ id }))),
      },
      clientSiteTutorialDraft: {
        findMany: jest
          .fn()
          .mockResolvedValue((live.drafts ?? []).map((id) => ({ id }))),
      },
    };
    const service = new CronJobsService(
      {} as never,
      {} as never,
      prisma as never,
      blobService as never,
      {
        runCleanupTick: jest.fn().mockResolvedValue({ expired: 0, purged: 0 }),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { service, blobService, prisma };
  }

  it('кадры ЖИВОГО черновика по сайту заказчика не удаляются', async () => {
    const { service, blobService } = buildFramesSweep({ drafts: ['draft-1'] });

    await service.runSweepOrphans({});

    const deleted = blobService.deleteMany.mock.calls.flatMap((c) => c[0]);
    expect(deleted).not.toContain('tutorial-video-frames/draft-1/0.jpg');
    // А кадры несуществующего ролика метутся, как и раньше.
    expect(deleted).toContain('tutorial-video-frames/tva-1/0.png');
  });

  it('живой РОЛИК тоже защищён — второй владелец не вытеснил первого', async () => {
    const { service, blobService } = buildFramesSweep({ assets: ['tva-1'] });

    await service.runSweepOrphans({});

    const deleted = blobService.deleteMany.mock.calls.flatMap((c) => c[0]);
    expect(deleted).not.toContain('tutorial-video-frames/tva-1/0.png');
    expect(deleted).toContain('tutorial-video-frames/draft-1/0.jpg');
  });

  it('спрашивает обе таблицы, а не одну', async () => {
    // Иначе «жив хотя бы у одного» держалось бы на удаче порядка.
    const { service, prisma } = buildFramesSweep({});

    await service.runSweepOrphans({});

    expect(prisma.tutorialVideoAsset.findMany).toHaveBeenCalled();
    expect(prisma.clientSiteTutorialDraft.findMany).toHaveBeenCalled();
  });

  it('сирота на третьей странице находится и удаляется', async () => {
    const { service, blobService } = buildPaged();
    const res = await service.runSweepOrphans({});
    expect(blobService.listByPrefix).toHaveBeenCalledTimes(
      // три страницы projects/ + по одной пустой у остальных семи
      // областей (sessions, brand-manifests, publications, shared-videos,
      // users, tutorial-video-frames, tutorial-video-posters — четыре
      // последние добавлялись позже исходного теста, отсюда 7, а не 3).
      3 + 7,
    );
    expect(blobService.deleteMany).toHaveBeenCalledWith([
      'projects/p-dead/items/i9/photo.png',
    ]);
    expect(res.byScope.projects).toMatchObject({
      scanned: 3,
      orphans: 1,
      pages: 3,
      complete: true,
    });
    expect(res.complete).toBe(true);
    expect(res.cursor).toBeNull();
  });

  it('курсор из query продолжает область сессий, а не остальные', async () => {
    const { service, blobService } = buildPaged();
    await service.runSweepOrphans({ cursor: 'sess-cursor' });
    const sessionsCall = blobService.listByPrefix.mock.calls.find(
      ([prefix]) => prefix === 'sessions/',
    );
    expect(sessionsCall?.[1]).toMatchObject({ cursor: 'sess-cursor' });
    const projectsFirst = blobService.listByPrefix.mock.calls.find(
      ([prefix]) => prefix === 'projects/',
    );
    expect(projectsFirst?.[1].cursor).toBeUndefined();
  });
});

describe('CronJobsService.runAndLog — история настоящего Vercel Cron (пятый аудит, Д-4.3)', () => {
  it('успех: пишет RUNNING → SUCCESS со сводкой и duration, возвращает результат задачи как есть', async () => {
    const { service, prisma } = build();
    const task = jest.fn().mockResolvedValue({ processed: 3, failed: 1 });

    const result = await service.runAndLog(
      'catalog-batch-run',
      VERCEL_CRON_TRIGGERED_BY,
      false,
      task,
    );

    expect(result).toEqual({ processed: 3, failed: 1 });
    expect(prisma.cronRunLog.create).toHaveBeenCalledWith({
      data: {
        jobKey: 'catalog-batch-run',
        triggeredBy: VERCEL_CRON_TRIGGERED_BY,
        debugMode: false,
        status: 'RUNNING',
      },
    });
    expect(prisma.cronRunLog.update).toHaveBeenCalledWith({
      where: { id: 'run-log-1' },
      data: expect.objectContaining({
        status: 'SUCCESS',
        finishedAt: expect.any(Date),
        durationMs: expect.any(Number),
        summary: 'processed=3, failed=1',
        // debugMode: false — debugLog не пишется вовсе (undefined).
        debugLog: undefined,
      }),
    });
  });

  it('debugMode: true — debugLog содержит сырой результат задачи', async () => {
    const { service, prisma } = build();
    const task = jest.fn().mockResolvedValue({ deleted: 5, dryRun: true });

    await service.runAndLog(
      'sweep-orphans',
      VERCEL_CRON_TRIGGERED_BY,
      true,
      task,
    );

    expect(prisma.cronRunLog.update).toHaveBeenCalledWith({
      where: { id: 'run-log-1' },
      data: expect.objectContaining({
        status: 'SUCCESS',
        debugLog: { deleted: 5, dryRun: true },
      }),
    });
  });

  it('провал задачи — пишет FAILED с текстом ошибки и ПЕРЕБРАСЫВАЕТ её (в отличие от AdminCronService.run)', async () => {
    const { service, prisma } = build();
    const task = jest.fn().mockRejectedValue(new Error('Veo недоступен'));

    await expect(
      service.runAndLog('ab-test-run', VERCEL_CRON_TRIGGERED_BY, false, task),
    ).rejects.toThrow('Veo недоступен');

    expect(prisma.cronRunLog.update).toHaveBeenCalledWith({
      where: { id: 'run-log-1' },
      data: {
        status: 'FAILED',
        finishedAt: expect.any(Date),
        durationMs: expect.any(Number),
        summary: 'Ошибка: Veo недоступен',
        errorMessage: 'Veo недоступен',
      },
    });
  });

  it('report — сводкой становится сам текст отчёта, тот же приём, что у ручного запуска', async () => {
    const { service, prisma } = build();
    const task = jest
      .fn()
      .mockResolvedValue({ sent: true, text: 'Отчёт за сутки: …' });

    await service.runAndLog('report', VERCEL_CRON_TRIGGERED_BY, false, task);

    expect(prisma.cronRunLog.update).toHaveBeenCalledWith({
      where: { id: 'run-log-1' },
      data: expect.objectContaining({ summary: 'Отчёт за сутки: …' }),
    });
  });
});

describe('CronJobsService.runAndLog — исход «пропущен» (аудит кронов 06.10.2026)', () => {
  it('пропуск пишется SUCCESS с отметкой SKIPPED и причиной — и без debug', async () => {
    const { service, prisma } = build();
    const result = {
      skipped: 'фикстурный вход не настроен',
      total: 0,
      passed: 0,
    };
    const task = jest.fn().mockResolvedValue(result);

    await service.runAndLog(
      'tutorial-scenario-run',
      VERCEL_CRON_TRIGGERED_BY,
      false,
      task,
    );

    expect(prisma.cronRunLog.update).toHaveBeenCalledWith({
      where: { id: 'run-log-1' },
      data: expect.objectContaining({
        status: 'SUCCESS',
        summary: 'пропущен — фикстурный вход не настроен',
        debugLog: {
          cronOutcome: 'SKIPPED',
          reason: 'фикстурный вход не настроен',
          result,
        },
      }),
    });
  });

  it('пропуск по замку (`skipped: true`) — тоже SKIPPED', async () => {
    const { service, prisma } = build();
    const task = jest
      .fn()
      .mockResolvedValue({ deleted: 0, failed: 0, skipped: true });

    await service.runAndLog(
      'voice-uploads-sweep',
      VERCEL_CRON_TRIGGERED_BY,
      false,
      task,
    );

    expect(prisma.cronRunLog.update).toHaveBeenCalledWith({
      where: { id: 'run-log-1' },
      data: expect.objectContaining({
        summary: 'пропущен — предыдущий прогон ещё держал замок',
        debugLog: expect.objectContaining({ cronOutcome: 'SKIPPED' }),
      }),
    });
  });

  it('генерация сценариев под чужим замком — пропуск с причиной, а не нули', async () => {
    const { service, prisma } = build();
    prisma.cronJobLock.create.mockRejectedValue(
      Object.assign(new Error('unique constraint'), { code: 'P2002' }),
    );
    prisma.cronJobLock.updateMany.mockResolvedValue({ count: 0 });

    await service.runAndLog(
      'tutorial-scenario-generate',
      VERCEL_CRON_TRIGGERED_BY,
      false,
      () => service.runTutorialScenarioGenerate(),
    );

    expect(prisma.cronRunLog.update).toHaveBeenCalledWith({
      where: { id: 'run-log-1' },
      data: expect.objectContaining({
        summary: 'пропущен — предыдущий прогон ещё не завершился',
        debugLog: expect.objectContaining({ cronOutcome: 'SKIPPED' }),
      }),
    });
  });
});

describe('CronJobsService.runExportSyncRun — крон-аналог для автоэкспорта яруса B (Е-2.3 шестого аудита, этап 76)', () => {
  it('делегирует ExportService.runSyncTick и отдаёт его результат как есть', async () => {
    const { service, exportService } = build();
    exportService.runSyncTick.mockResolvedValue({ checked: 5, failed: 1 });

    const result = await service.runExportSyncRun();

    expect(exportService.runSyncTick).toHaveBeenCalledTimes(1);
    // Без аргументов — сам runSyncTick использует свой умолчальный лимит.
    expect(exportService.runSyncTick).toHaveBeenCalledWith();
    expect(result).toEqual({ checked: 5, failed: 1 });
  });
});

describe('CronJobsService.runTutorialScenarioGenerate — генерация сценариев для автозаписи обучающих видео (этап 94, ТЗ §4.10)', () => {
  it('делегирует TutorialScenarioGeneratorService.run и отдаёт его результат как есть', async () => {
    const { service, tutorialScenarioGenerator } = build();
    tutorialScenarioGenerator.run.mockResolvedValue({
      subjectKeys: 10,
      generated: 8,
      costly: 2,
      failed: 2,
      failures: [{ subjectKey: '3', reason: 'JSON не распарсился' }],
    });

    const result = await service.runTutorialScenarioGenerate();

    expect(tutorialScenarioGenerator.run).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      subjectKeys: 10,
      generated: 8,
      costly: 2,
      failed: 2,
      failures: [{ subjectKey: '3', reason: 'JSON не распарсился' }],
    });
  });

  // Тот же джоб-замок, что у runBlog/runExportSyncRun — двойной клик
  // оператора («ручной запуск» в админке) поверх уже идущего суточного
  // прогона не должен звать Gemini второй раз параллельно.
  it('джоб-замок: второй прогон поверх уже идущего — пропуск, генератор не вызван', async () => {
    const { service, prisma, tutorialScenarioGenerator } = build();
    prisma.cronJobLock.create.mockRejectedValue(
      Object.assign(new Error('unique constraint'), { code: 'P2002' }),
    );
    prisma.cronJobLock.updateMany.mockResolvedValue({ count: 0 });

    const result = await service.runTutorialScenarioGenerate();

    expect(tutorialScenarioGenerator.run).not.toHaveBeenCalled();
    expect(result).toEqual({
      // Пропуск назван (аудит кронов 06.10.2026): без `skipped` он
      // писался в журнал нулями и успехом.
      skipped: 'предыдущий прогон ещё не завершился',
      pairs: 0,
      // Пустой список локалей, а не `['ru']`: прогона не было
      // вовсе, и сказать, на каких языках генерировали, нечего
      // (этап C).
      locales: [],
      skippedManual: 0,
      deferred: 0,
      generated: 0,
      costly: 0,
      failed: 0,
      failures: [],
      narrationsDropped: 0,
    });
  });
});

describe('CronJobsService.runTutorialScenarioRun — исполнение сценариев обучающих видео (этап 97, §5 ТЗ)', () => {
  it('делегирует TutorialScenarioRunnerService.run и отдаёт его результат как есть', async () => {
    const { service, tutorialScenarioRunner } = build();
    tutorialScenarioRunner.run.mockResolvedValue({
      total: 3,
      passed: 2,
      failed: 1,
      outcomes: [{ id: 'ts-1', subjectKey: '1', ok: true }],
    });

    const result = await service.runTutorialScenarioRun();

    expect(tutorialScenarioRunner.run).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      total: 3,
      passed: 2,
      failed: 1,
      outcomes: [{ id: 'ts-1', subjectKey: '1', ok: true }],
    });
  });

  // Свой джоб-лок, отдельный от tutorial-scenario-generate (см.
  // доккомментарий метода) — двойной запуск (ручной поверх ночного)
  // не должен открывать второй Chromium параллельно.
  it('джоб-замок: второй прогон поверх уже идущего — пропуск, исполнитель не вызван', async () => {
    const { service, prisma, tutorialScenarioRunner } = build();
    prisma.cronJobLock.create.mockRejectedValue(
      Object.assign(new Error('unique constraint'), { code: 'P2002' }),
    );
    prisma.cronJobLock.updateMany.mockResolvedValue({ count: 0 });

    const result = await service.runTutorialScenarioRun();

    expect(tutorialScenarioRunner.run).not.toHaveBeenCalled();
    expect(result).toEqual({
      skipped: 'предыдущий прогон ещё не завершился',
      total: 0,
      passed: 0,
      failed: 0,
      paidClicksSkipped: 0,
      narrationFallbacks: 0,
      framesMissed: 0,
      withoutFrames: 0,
      lostRaces: 0,
      repeatFailures: 0,
      assemblyTimeouts: 0,
      outcomes: [],
    });
  });
});

describe('CronJobsService.runTutorialAssemblyPoll — опрос сборок обучалки (сквозной аудит 27.09.2026, Д-2)', () => {
  it('зовёт pollAssemblies, а НЕ полный прогон сценариев', async () => {
    const { service, tutorialScenarioRunner } = build();
    tutorialScenarioRunner.pollAssemblies.mockResolvedValue({
      polled: 1,
      pending: 4,
    });

    const result = await service.runTutorialAssemblyPoll();

    expect(tutorialScenarioRunner.pollAssemblies).toHaveBeenCalledTimes(1);
    // Ради этого слот и разделён: общий прогон держит headless-браузер
    // минутами и раз в две минуты запускаться не может.
    expect(tutorialScenarioRunner.run).not.toHaveBeenCalled();
    expect(result).toEqual({ polled: 1, pending: 4 });
  });

  // Замка ЗДЕСЬ больше нет, и это правка аудита 27.09.2026. Он взят
  // внутри `pollAssemblies()`, потому что те же строки опрашивает и
  // суточный прогон: пока замок принадлежал крону, тот шёл в обход, и
  // проигравший помечал готовую сборку сбойной. Проверка замка живёт
  // теперь в `tutorial-scenario-runner.service.spec.ts`.
  it('замок здесь не берётся — он принадлежит самому опросу', async () => {
    const { service, prisma } = build();

    await service.runTutorialAssemblyPoll();

    expect(prisma.cronJobLock.create).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ jobKey: 'tutorial-assembly-poll' }),
      }),
    );
  });

  it('пропуск по замку доезжает до вызывающего как есть', async () => {
    const { service, tutorialScenarioRunner } = build();
    tutorialScenarioRunner.pollAssemblies.mockResolvedValue({
      skipped: 'предыдущий опрос ещё не завершился',
      polled: 0,
    });

    const result = await service.runTutorialAssemblyPoll();

    expect(result).toEqual({
      skipped: 'предыдущий опрос ещё не завершился',
      polled: 0,
    });
  });
});

describe('CronJobsService.runUiSnapshotRun — крон-обход интерфейса TMA (этап 100, §3 ТЗ)', () => {
  it('делегирует UiSnapshotRunnerService.run и отдаёт его результат как есть', async () => {
    const { service, uiSnapshotRunner } = build();
    uiSnapshotRunner.run.mockResolvedValue({
      total: 5,
      changed: 1,
      failed: 0,
      outcomes: [{ routeKey: 'generate', changed: true }],
    });

    const result = await service.runUiSnapshotRun();

    expect(uiSnapshotRunner.run).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      total: 5,
      changed: 1,
      failed: 0,
      outcomes: [{ routeKey: 'generate', changed: true }],
    });
  });

  // Свой джоб-лок, отдельный и от tutorial-scenario-generate, и от
  // tutorial-scenario-run (см. доккомментарий метода) — повторный запуск
  // (ручной поверх крона на расписании `*/2 * * * *`) не должен открывать
  // второй Chromium параллельно.
  it('джоб-замок: второй прогон поверх уже идущего — пропуск, исполнитель не вызван', async () => {
    const { service, prisma, uiSnapshotRunner } = build();
    prisma.cronJobLock.create.mockRejectedValue(
      Object.assign(new Error('unique constraint'), { code: 'P2002' }),
    );
    prisma.cronJobLock.updateMany.mockResolvedValue({ count: 0 });

    const result = await service.runUiSnapshotRun();

    expect(uiSnapshotRunner.run).not.toHaveBeenCalled();
    expect(result).toEqual({
      skipped: 'предыдущий прогон ещё не завершился',
      total: 0,
      changed: 0,
      failed: 0,
      outcomes: [],
    });
  });
});

describe('CronJobsService.runBlog — генерация + перевод + бэкофилл обложек (этап 95, третий шаг)', () => {
  it('зовёт все три шага по очереди и складывает результаты в один объект', async () => {
    const { service, blogGeneration, blogTranslation } = build();

    const result = await service.runBlog();

    expect(blogGeneration.runDailyGeneration).toHaveBeenCalled();
    expect(blogTranslation.runTranslationCron).toHaveBeenCalled();
    expect(blogGeneration.runCoverImageBackfill).toHaveBeenCalled();
    expect(result).toEqual({
      generation: {
        categoriesTried: 0,
        candidatesConsidered: 0,
        draftsCreated: 0,
        skippedBudget: false,
      },
      translation: {
        polledJobs: 0,
        completedJobs: 0,
        translationsEnsured: 0,
        submittedBatch: 'not-configured',
      },
      coverBackfill: { candidates: 0, uploaded: 0, stillFallback: 0 },
    });
  });

  // Тот же джоб-замок, что у runCleanupSessions/runTutorialScenarioGenerate.
  it('джоб-замок: второй прогон поверх уже идущего — пропуск, ничего не вызвано', async () => {
    const { service, prisma, blogGeneration, blogTranslation } = build();
    prisma.cronJobLock.create.mockRejectedValue(
      Object.assign(new Error('unique constraint'), { code: 'P2002' }),
    );
    prisma.cronJobLock.updateMany.mockResolvedValue({ count: 0 });

    const result = await service.runBlog();

    expect(blogGeneration.runDailyGeneration).not.toHaveBeenCalled();
    expect(blogTranslation.runTranslationCron).not.toHaveBeenCalled();
    expect(blogGeneration.runCoverImageBackfill).not.toHaveBeenCalled();
    expect(result).toEqual({
      generation: { skipped: true },
      translation: { skipped: true },
      coverBackfill: { skipped: true },
    });
  });
});

describe('CronJobsService — аудиокеш голоса советника (Greeting 2.0 §4А.4)', () => {
  it('суточная уборка убирает озвучку, не звучавшую 30 дней, вместе с файлом', async () => {
    const { service, prisma, blobService } = build();
    let listed = false;
    (prisma as Record<string, unknown>).wizardHintAudio = {
      findMany: jest.fn(async (args: { where: { lastUsedAt?: unknown } }) => {
        if (!args.where.lastUsedAt) return [];
        if (listed) return [];
        listed = true;
        return [{ key: 'k', pathname: 'wizard-hint-audio/k.mp3' }];
      }),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    };
    await service.runCleanupSessions();
    expect(blobService.deleteMany).toHaveBeenCalledWith([
      'wizard-hint-audio/k.mp3',
    ]);
  });
});

describe('CronJobsService — срок хранения снимков интерфейса (ui-snapshot-run)', () => {
  const pruneMock = () =>
    jest.requireMock('../ui-snapshot/ui-snapshot-retention')
      .pruneUiSnapshots as jest.Mock;

  it('суточная уборка зовёт уборку снимков и кладёт счётчики в отчёт и summary', async () => {
    const { service, prisma, blobService } = build();
    pruneMock().mockResolvedValueOnce({
      deleted: 7,
      deletedBlobs: 5,
      failed: 2,
      hasMore: true,
      pages: 20,
      ms: 29_512,
    });

    const result = await service.runCleanupSessions();

    const [[p, b, opts]] = pruneMock().mock.calls.slice(-1) as [
      [unknown, unknown, { now: Date; deadlineMs: number }],
    ];
    expect(p).toBe(prisma);
    expect(b).toBe(blobService);
    const { UI_SNAPSHOT_PRUNE_TIME_BUDGET_MS } = jest.requireActual(
      '../ui-snapshot/ui-snapshot-retention',
    );
    expect(opts.deadlineMs - opts.now.getTime()).toBe(
      UI_SNAPSHOT_PRUNE_TIME_BUDGET_MS,
    );
    expect(result).toMatchObject({
      deletedUiSnapshots: 7,
      deletedUiSnapshotBlobs: 5,
      uiSnapshotCleanupFailed: 2,
      hasMoreUiSnapshots: true,
      uiSnapshotCleanupPages: 20,
      uiSnapshotCleanupMs: 29_512,
    });
    const { buildRunSummary } = await import('./cron-run-summary');
    const summary = buildRunSummary('cleanup-sessions', result);
    expect(summary).toContain('deletedUiSnapshots=7');
    expect(summary).toContain('deletedUiSnapshotBlobs=5');
    expect(summary).toContain('uiSnapshotCleanupFailed=2');
    // Успевает ли уборка за притоком — видно без debug.
    expect(summary).toContain('uiSnapshotCleanupPages=20');
    expect(summary).toContain('uiSnapshotCleanupMs=29512');
  });

  it('настоящая уборка: старый обычный снимок уходит, файл — под qa-snapshots/', async () => {
    const { service, prisma, blobService } = build();
    const old = new Date(Date.now() - 5 * 86_400_000);
    const url = `https://s.public.blob.vercel-storage.com/qa-snapshots/home/ru/light/${old.getTime()}.png`;
    prisma.uiSnapshot.groupBy.mockResolvedValue([
      { routeKey: 'home', locale: 'ru', theme: 'light' },
    ]);
    prisma.uiSnapshot.findMany.mockResolvedValueOnce([
      { id: 'old', createdAt: old, changed: false, error: null, blobUrl: url },
    ]);
    // Позже есть обычный снимок — `old` не база и не «было».
    prisma.uiSnapshot.findFirst.mockResolvedValueOnce({
      id: 'next',
      createdAt: new Date(),
      changed: false,
      comparedToUrl: url,
    });
    prisma.uiSnapshot.deleteMany.mockResolvedValue({ count: 1 });

    const result = await service.runCleanupSessions();

    expect(blobService.deleteMany).toHaveBeenCalledWith(
      [`qa-snapshots/home/ru/light/${old.getTime()}.png`],
      1,
    );
    expect(prisma.uiSnapshot.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['old'] } },
    });
    expect(result.deletedUiSnapshots).toBe(1);
    expect(result.deletedUiSnapshotBlobs).toBe(1);
  });

  it('сбой уборки снимков не роняет уборку сессий', async () => {
    const { service, prisma } = build();
    prisma.uiSnapshot.groupBy.mockRejectedValue(new Error('база лежит'));

    const result = await service.runCleanupSessions();

    expect(result.deletedUiSnapshots).toBe(0);
    expect(result.uiSnapshotCleanupFailed).toBe(0);
    expect(result.deletedCount).toBe(2);
  });
});

describe('CronJobsService — voice-uploads-sweep (финальный аудит ветки K)', () => {
  it('под замком зовёт уборку записей старше часа и снимает замок', async () => {
    const { service, voiceUploads, prisma } = build();
    voiceUploads.sweepExpired.mockResolvedValue({
      deleted: 3,
      failed: 0,
      hasMore: false,
    });
    await expect(service.runVoiceUploadsSweep()).resolves.toEqual({
      deleted: 3,
      failed: 0,
      hasMore: false,
    });
    expect(voiceUploads.sweepExpired).toHaveBeenCalledTimes(1);
    expect(prisma.cronJobLock.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ jobKey: 'voice-uploads-sweep' }),
      }),
    );
  });

  it('замок занят — пропуск, уборка не зовётся', async () => {
    const { service, voiceUploads, prisma } = build();
    prisma.cronJobLock.create.mockRejectedValue(
      Object.assign(new Error('unique constraint'), { code: 'P2002' }),
    );
    prisma.cronJobLock.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.runVoiceUploadsSweep()).resolves.toEqual({
      deleted: 0,
      failed: 0,
      hasMore: false,
      skipped: true,
    });
    expect(voiceUploads.sweepExpired).not.toHaveBeenCalled();
  });

  it('расписание — минутами (не реже получаса), а не раз в сутки', () => {
    const json = JSON.parse(
      readFileSync(join(__dirname, '..', '..', '..', 'vercel.json'), 'utf8'),
    ) as { crons: Array<{ path: string; schedule: string }> };
    const slot = json.crons.find(
      (c) => c.path === '/api/cron/voice-uploads-sweep',
    );
    expect(slot).toBeDefined();
    const m = /^\*\/(\d+) \* \* \* \*$/.exec(slot!.schedule);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeLessThanOrEqual(30);
  });
});

describe('CronJobsService — persona-sources-purge (этап E Greeting 2.0, В-3)', () => {
  it('под замком зовёт уборку источников персон и снимает замок', async () => {
    const { service, personas, prisma } = build();
    personas.purgeExpiredSources.mockResolvedValue({
      purged: 2,
      abandoned: 1,
      failed: 0,
    });
    await expect(service.runPersonaSourcesPurge()).resolves.toEqual({
      purged: 2,
      abandoned: 1,
      failed: 0,
    });
    expect(personas.purgeExpiredSources).toHaveBeenCalledTimes(1);
    expect(prisma.cronJobLock.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ jobKey: 'persona-sources-purge' }),
      }),
    );
  });

  it('замок занят — пропуск, уборка не зовётся', async () => {
    const { service, personas, prisma } = build();
    prisma.cronJobLock.create.mockRejectedValue(
      Object.assign(new Error('unique constraint'), { code: 'P2002' }),
    );
    prisma.cronJobLock.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.runPersonaSourcesPurge()).resolves.toEqual({
      purged: 0,
      abandoned: 0,
      erased: 0,
      failed: 0,
      skipped: true,
    });
    expect(personas.purgeExpiredSources).not.toHaveBeenCalled();
  });

  it('в расписании vercel.json — не реже раза в сутки', () => {
    const json = JSON.parse(
      readFileSync(join(__dirname, '..', '..', '..', 'vercel.json'), 'utf8'),
    ) as { crons: Array<{ path: string; schedule: string }> };
    const slot = json.crons.find(
      (c) => c.path === '/api/cron/persona-sources-purge',
    );
    expect(slot).toBeDefined();
    expect(slot!.schedule).toMatch(/^\d+ \d+ \* \* \*$/);
  });
});

describe('CronJobsService — client-site-retention (Ш0.5/Ш0.6 аудита 02.10.2026)', () => {
  it('под замком прогоняет сроки хранения обучалки и снимает замок', async () => {
    const { service, prisma } = build();
    const p = prisma as unknown as Record<string, Record<string, jest.Mock>>;
    p.clientSiteTutorialDraft = {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 2 }),
    };
    p.tutorialVideoAsset = {
      ...(p.tutorialVideoAsset ?? {}),
      findMany: jest.fn().mockResolvedValue([]),
    };
    await expect(service.runClientSiteRetention()).resolves.toEqual({
      secretsExpired: 2,
      secretsOneShot: 0,
      framesPurged: 0,
      framesFailed: 0,
      pendingReviewWarned: 0,
    });
    expect(prisma.cronJobLock.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ jobKey: 'client-site-retention' }),
      }),
    );
  });

  it('замок занят — пропуск, база не трогается', async () => {
    const { service, prisma } = build();
    const p = prisma as unknown as Record<string, Record<string, jest.Mock>>;
    p.clientSiteTutorialDraft = { updateMany: jest.fn(), findMany: jest.fn() };
    prisma.cronJobLock.create.mockRejectedValue(
      Object.assign(new Error('unique constraint'), { code: 'P2002' }),
    );
    prisma.cronJobLock.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.runClientSiteRetention()).resolves.toMatchObject({
      skipped: true,
    });
    expect(p.clientSiteTutorialDraft.updateMany).not.toHaveBeenCalled();
  });

  it('в расписании vercel.json — раз в сутки', () => {
    const json = JSON.parse(
      readFileSync(join(__dirname, '..', '..', '..', 'vercel.json'), 'utf8'),
    ) as { crons: Array<{ path: string; schedule: string }> };
    const slot = json.crons.find(
      (c) => c.path === '/api/cron/client-site-retention',
    );
    expect(slot!.schedule).toMatch(/^\d+ \d+ \* \* \*$/);
  });
});
