/**
 * Этап 69: бизнес-логика кронов переехала в `CronJobsService` (см.
 * `cron-jobs.service.spec.ts`) — этот файл проверяет только то, что
 * реально осталось в `CronController`: секрет закрывает КАЖДЫЙ из
 * пятнадцати маршрутов, а при верном секрете контроллер честно
 * делегирует в `CronJobsService` и возвращает результат как есть.
 *
 * Оба маршрута про удаление файлов из Blob (`cleanup-sessions`,
 * `sweep-orphans`) — необратимая операция, и единственный барьер до неё
 * снаружи — сравнение с `CRON_SECRET`, поэтому им уделено чуть больше
 * внимания (заголовка нет вовсе / секрет не настроен на не-dev стенде).
 */

jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
// `CronController` импортирует `CronJobsService`, а тот — сервисы,
// рантайм-импортирующие перечисления `@prisma/client` (см. тот же
// комментарий в `cron-jobs.service.spec.ts`). Здесь эти сервисы не
// нужны вообще (jobs мокается напрямую), но модуль всё равно грузится
// по цепочке импортов.
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
jest.mock('../project/project.service', () => ({ ProjectService: class {} }));
// Этап 89: тот же класс проблемы, что у четырёх сервисов выше, просто
// не заведённый в мок вовремя (этапы 65/66) — см. тот же комментарий в
// `cron-jobs.service.spec.ts`.
jest.mock('../catalog-batch/catalog-batch-worker.service', () => ({
  CatalogBatchWorkerService: class {},
}));
jest.mock('../ab-test/ab-test-worker.service', () => ({
  AbTestWorkerService: class {},
}));

import {
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { CronController } from './cron.controller';

function build() {
  const jobs = {
    runReport: jest.fn().mockResolvedValue({ sent: true, text: 'отчёт' }),
    runBlog: jest.fn().mockResolvedValue({ generation: {}, translation: {} }),
    runPublish: jest.fn().mockResolvedValue({ processed: 0 }),
    runBillingRenew: jest.fn().mockResolvedValue({ processed: 0 }),
    runMarketingBroadcast: jest.fn().mockResolvedValue({ processed: 0 }),
    runCatalogBatchRun: jest.fn().mockResolvedValue({ processed: 0 }),
    runAbTestRun: jest.fn().mockResolvedValue({ processed: 0 }),
    runFeedImportRun: jest.fn().mockResolvedValue({ claimedRuns: 0 }),
    runExportSyncRun: jest.fn().mockResolvedValue({ checked: 0, failed: 0 }),
    runTutorialScenarioGenerate: jest.fn().mockResolvedValue({
      subjectKeys: 10,
      generated: 10,
      costly: 0,
      failed: 0,
      failures: [],
    }),
    runTutorialScenarioRun: jest.fn().mockResolvedValue({
      total: 0,
      passed: 0,
      failed: 0,
      outcomes: [],
    }),
    runUiSnapshotRun: jest.fn().mockResolvedValue({
      total: 0,
      changed: 0,
      failed: 0,
      outcomes: [],
    }),
    runCleanupSessions: jest.fn().mockResolvedValue({ deletedCount: 2 }),
    runAiUsageRollup: jest
      .fn()
      .mockResolvedValue({ months: [], foldedRows: 0, deletedRows: 0 }),
    runSweepOrphans: jest.fn().mockResolvedValue({ deleted: 0, dryRun: false }),
    // Пятый аудит, Д-4.3: контроллер больше не зовёт `runX()` напрямую —
    // каждый маршрут оборачивает его в `runAndLog`. Мок здесь просто
    // прозрачно выполняет переданную задачу — сама логика записи
    // `CronRunLog` проверяется отдельно в cron-jobs.service.spec.ts, а
    // здесь важно только то, что КАЖДЫЙ маршрут зовёт `runAndLog` с
    // правильными jobKey/triggeredBy/debugMode (см. тесты ниже).
    runAndLog: jest.fn(
      (
        _jobKey: string,
        _triggeredBy: string,
        _debugMode: boolean,
        task: () => Promise<unknown>,
      ) => task(),
    ),
  };
  const controller = new CronController(jobs as never);
  return { controller, jobs };
}

const previousEnv = {
  CRON_SECRET: process.env.CRON_SECRET,
  ALLOW_DEV_AUTH: process.env.ALLOW_DEV_AUTH,
  NODE_ENV: process.env.NODE_ENV,
};
afterEach(() => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/**
 * Тесты, которым секрет не интересен, работают как dev-стенд: с этапа 54
 * отсутствие `CRON_SECRET` само по себе маршрут больше не открывает
 * (Б-3.3), открывают его те же два предохранителя, что dev-вход в админку.
 */
function devStand(): void {
  delete process.env.CRON_SECRET;
  process.env.ALLOW_DEV_AUTH = 'true';
  process.env.NODE_ENV = 'test';
}

describe('CronController — секрет закрывает каждый из пятнадцати маршрутов', () => {
  const cases: Array<
    [
      string,
      (c: CronController) => Promise<unknown>,
      keyof ReturnType<typeof build>['jobs'],
    ]
  > = [
    ['report', (c) => c.report('Bearer подделка'), 'runReport'],
    ['blog', (c) => c.blog('Bearer подделка'), 'runBlog'],
    ['publish', (c) => c.publish('Bearer подделка'), 'runPublish'],
    [
      'billing-renew',
      (c) => c.billingRenew('Bearer подделка'),
      'runBillingRenew',
    ],
    [
      'marketing-broadcast',
      (c) => c.marketingBroadcastCron('Bearer подделка'),
      'runMarketingBroadcast',
    ],
    [
      'catalog-batch-run',
      (c) => c.catalogBatchRunCron('Bearer подделка'),
      'runCatalogBatchRun',
    ],
    ['ab-test-run', (c) => c.abTestRunCron('Bearer подделка'), 'runAbTestRun'],
    [
      'feed-import-run',
      (c) => c.feedImportRunCron('Bearer подделка'),
      'runFeedImportRun',
    ],
    [
      'export-sync-run',
      (c) => c.exportSyncRunCron('Bearer подделка'),
      'runExportSyncRun',
    ],
    [
      'tutorial-scenario-generate',
      (c) => c.tutorialScenarioGenerateCron('Bearer подделка'),
      'runTutorialScenarioGenerate',
    ],
    [
      'tutorial-scenario-run',
      (c) => c.tutorialScenarioRunCron('Bearer подделка'),
      'runTutorialScenarioRun',
    ],
    [
      'ui-snapshot-run',
      (c) => c.uiSnapshotRunCron('Bearer подделка'),
      'runUiSnapshotRun',
    ],
    [
      'cleanup-sessions',
      (c) => c.cleanupSessions('Bearer подделка'),
      'runCleanupSessions',
    ],
    [
      'ai-usage-rollup',
      (c) => c.aiUsageRollup('Bearer подделка'),
      'runAiUsageRollup',
    ],
    [
      'sweep-orphans',
      (c) => c.sweepOrphans('Bearer подделка'),
      'runSweepOrphans',
    ],
  ];

  it.each(cases)(
    'чужой секрет: %s не вызывает CronJobsService',
    async (_name, call, jobMethod) => {
      process.env.CRON_SECRET = 'настоящий';
      const { controller, jobs } = build();
      await expect(call(controller)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(jobs[jobMethod]).not.toHaveBeenCalled();
    },
  );

  it('заголовка нет вовсе — тот же отказ, что и при неверном секрете', async () => {
    process.env.CRON_SECRET = 'настоящий';
    const { controller, jobs } = build();
    await expect(controller.cleanupSessions()).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(controller.sweepOrphans()).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(jobs.runCleanupSessions).not.toHaveBeenCalled();
    expect(jobs.runSweepOrphans).not.toHaveBeenCalled();
  });

  it('секрет не задан и это не dev-стенд — маршрут закрыт, а не открыт (этап 54, Б-3.3)', async () => {
    delete process.env.CRON_SECRET;
    delete process.env.ALLOW_DEV_AUTH;
    const { controller, jobs } = build();
    await expect(controller.cleanupSessions()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await expect(controller.sweepOrphans()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(jobs.runCleanupSessions).not.toHaveBeenCalled();
    expect(jobs.runSweepOrphans).not.toHaveBeenCalled();
  });

  it('верный секрет пускает и делегирует в CronJobsService', async () => {
    process.env.CRON_SECRET = 'настоящий';
    const { controller, jobs } = build();
    const result = await controller.cleanupSessions('Bearer настоящий');
    expect(jobs.runCleanupSessions).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ deletedCount: 2 });
  });

  it('CRON_SECRET не задан — проверка выключена (dev-стенд без настройки)', async () => {
    devStand();
    const { controller, jobs } = build();
    await expect(controller.cleanupSessions()).resolves.toEqual({
      deletedCount: 2,
    });
    expect(jobs.runCleanupSessions).toHaveBeenCalledTimes(1);
  });
});

describe('CronController — sweep-orphans пробрасывает query как есть', () => {
  it('cursor/limit/minAgeHours/dryRun уходят в CronJobsService.runSweepOrphans', async () => {
    devStand();
    const { controller, jobs } = build();
    await controller.sweepOrphans(undefined, 'c1', '100', '48', '1');
    expect(jobs.runSweepOrphans).toHaveBeenCalledWith({
      cursor: 'c1',
      limit: '100',
      minAgeHours: '48',
      dryRun: '1',
    });
  });
});

describe('CronController — каждый маршрут оборачивает свой runX() в runAndLog (пятый аудит, Д-4.3)', () => {
  const VERCEL_CRON_TRIGGERED_BY = 'vercel-cron';
  const cases: Array<
    [string, (c: CronController) => Promise<unknown>, string]
  > = [
    ['report', (c) => c.report(), 'report'],
    ['blog', (c) => c.blog(), 'blog'],
    ['publish', (c) => c.publish(), 'publish'],
    ['billing-renew', (c) => c.billingRenew(), 'billing-renew'],
    [
      'marketing-broadcast',
      (c) => c.marketingBroadcastCron(),
      'marketing-broadcast',
    ],
    ['catalog-batch-run', (c) => c.catalogBatchRunCron(), 'catalog-batch-run'],
    ['ab-test-run', (c) => c.abTestRunCron(), 'ab-test-run'],
    ['feed-import-run', (c) => c.feedImportRunCron(), 'feed-import-run'],
    ['export-sync-run', (c) => c.exportSyncRunCron(), 'export-sync-run'],
    [
      'tutorial-scenario-generate',
      (c) => c.tutorialScenarioGenerateCron(),
      'tutorial-scenario-generate',
    ],
    [
      'tutorial-scenario-run',
      (c) => c.tutorialScenarioRunCron(),
      'tutorial-scenario-run',
    ],
    ['ui-snapshot-run', (c) => c.uiSnapshotRunCron(), 'ui-snapshot-run'],
    ['cleanup-sessions', (c) => c.cleanupSessions(), 'cleanup-sessions'],
    ['ai-usage-rollup', (c) => c.aiUsageRollup(), 'ai-usage-rollup'],
  ];

  it.each(cases)(
    '%s: runAndLog зовётся с правильным jobKey и меткой vercel-cron, debugMode=false',
    async (_name, call, expectedJobKey) => {
      devStand();
      const { controller, jobs } = build();
      await call(controller);
      expect(jobs.runAndLog).toHaveBeenCalledWith(
        expectedJobKey,
        VERCEL_CRON_TRIGGERED_BY,
        false,
        expect.any(Function),
      );
    },
  );

  it('sweep-orphans: debugMode отражает реальный dryRun=1 из query (как и у ручного запуска)', async () => {
    devStand();
    const { controller, jobs } = build();
    await controller.sweepOrphans(
      undefined,
      undefined,
      undefined,
      undefined,
      '1',
    );
    expect(jobs.runAndLog).toHaveBeenCalledWith(
      'sweep-orphans',
      VERCEL_CRON_TRIGGERED_BY,
      true,
      expect.any(Function),
    );
  });

  it('sweep-orphans: без dryRun — debugMode=false', async () => {
    devStand();
    const { controller, jobs } = build();
    await controller.sweepOrphans();
    expect(jobs.runAndLog).toHaveBeenCalledWith(
      'sweep-orphans',
      VERCEL_CRON_TRIGGERED_BY,
      false,
      expect.any(Function),
    );
  });
});
