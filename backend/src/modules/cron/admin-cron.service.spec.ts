/**
 * AdminCronService — ручной запуск кронов из админки (этап 69).
 * Проверяем то, что решили с владельцем продукта (AskUserQuestion):
 * debug у devять из десяти джобов влияет только на видимость debugLog,
 * а у sweep-orphans — на поведение (dryRun); плюс базовую механику
 * (неизвестный jobKey, запись истории, FAILED-ветка).
 */

jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
// `AdminCronService` типизирован через `CronJobsService`, а тот тянет за
// собой сервисы, рантайм-импортирующие перечисления `@prisma/client`
// (см. тот же комментарий в `cron-jobs.service.spec.ts`) — здесь `jobs`
// мокается напрямую, но модуль всё равно грузится по цепочке импортов.
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

import { BadRequestException } from '@nestjs/common';
import { AdminCronService } from './admin-cron.service';

function build() {
  const rows: Record<string, unknown>[] = [];
  const prisma = {
    cronRunLog: {
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `row-${rows.length + 1}`, ...data };
        rows.push(row);
        return Promise.resolve(row);
      }),
      update: jest.fn(
        ({
          where,
          data,
        }: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => {
          const row = rows.find((r) => r.id === where.id);
          Object.assign(row as object, data);
          return Promise.resolve(row);
        },
      ),
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
  const jobs = {
    runReport: jest
      .fn()
      .mockResolvedValue({ sent: true, text: 'суточный отчёт' }),
    runBlog: jest.fn().mockResolvedValue({
      generation: { draftsCreated: 2, skippedBudget: false },
      translation: { completedJobs: 1 },
    }),
    runPublish: jest
      .fn()
      .mockResolvedValue({ processed: 3, published: 2, failed: 1 }),
    runBillingRenew: jest.fn().mockResolvedValue({ processed: 1, renewed: 1 }),
    runMarketingBroadcast: jest.fn().mockResolvedValue({ sent: 5, failed: 0 }),
    runCatalogBatchRun: jest
      .fn()
      .mockResolvedValue({ processed: 4, started: 4 }),
    runAbTestRun: jest.fn().mockResolvedValue({ processed: 2, started: 2 }),
    runFeedImportRun: jest
      .fn()
      .mockResolvedValue({ claimedRuns: 1, importedItems: 10 }),
    runExportSyncRun: jest.fn().mockResolvedValue({ checked: 3, failed: 0 }),
    runTutorialScenarioGenerate: jest.fn().mockResolvedValue({
      subjectKeys: 10,
      generated: 9,
      costly: 1,
      failed: 1,
      failures: [{ subjectKey: '5', reason: 'JSON не распарсился' }],
    }),
    runUiSnapshotRun: jest.fn().mockResolvedValue({
      total: 5,
      changed: 1,
      failed: 0,
      outcomes: [],
    }),
    runTutorialScenarioRun: jest.fn().mockResolvedValue({
      total: 3,
      passed: 2,
      failed: 1,
      outcomes: [],
    }),
    runCleanupSessions: jest
      .fn()
      .mockResolvedValue({ deletedCount: 7, deletedBlobs: 3 }),
    runSweepOrphans: jest
      .fn()
      .mockResolvedValue({ deleted: 0, dryRun: false, byKind: {} }),
  };
  const service = new AdminCronService(jobs as never, prisma as never);
  return { service, jobs, prisma };
}

describe('AdminCronService — реестр и неизвестный jobKey', () => {
  it('реестр содержит все четырнадцать джобов', () => {
    const { service } = build();
    expect(service.getRegistry()).toHaveLength(14);
  });

  it('запуск неизвестного jobKey отклоняется до вызова CronJobsService', async () => {
    const { service, jobs, prisma } = build();
    await expect(
      service.run('не-существует', 'admin-1', false),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(jobs.runReport).not.toHaveBeenCalled();
    expect(prisma.cronRunLog.create).not.toHaveBeenCalled();
  });
});

describe('AdminCronService — debug у девяти джобов только раскрывает debugLog', () => {
  it('без debug: summary есть, debugLog отсутствует', async () => {
    const { service, jobs } = build();
    const row = await service.run('billing-renew', 'admin-1', false);
    expect(jobs.runBillingRenew).toHaveBeenCalledTimes(1);
    expect(row.status).toBe('SUCCESS');
    expect(row.summary).toContain('processed=1');
    expect(row.debugLog).toBeUndefined();
  });

  it('с debug: debugLog содержит весь результат целиком', async () => {
    const { service } = build();
    const row = await service.run('billing-renew', 'admin-1', true);
    expect(row.debugLog).toEqual({ processed: 1, renewed: 1 });
  });

  it('report: summary — это сам текст отчёта', async () => {
    const { service } = build();
    const row = await service.run('report', 'admin-1', false);
    expect(row.summary).toBe('суточный отчёт');
  });

  it('blog: summary собирает обе половины (генерация + перевод)', async () => {
    const { service } = build();
    const row = await service.run('blog', 'admin-1', false);
    expect(row.summary).toContain('draftsCreated=2');
    expect(row.summary).toContain('completedJobs=1');
  });

  it('export-sync-run: делегирует CronJobsService.runExportSyncRun (Е-2.3 шестого аудита, этап 76)', async () => {
    const { service, jobs } = build();
    const row = await service.run('export-sync-run', 'admin-1', false);
    expect(jobs.runExportSyncRun).toHaveBeenCalledTimes(1);
    expect(row.status).toBe('SUCCESS');
    expect(row.summary).toContain('checked=3');
  });

  it('tutorial-scenario-generate: делегирует CronJobsService.runTutorialScenarioGenerate (этап 94, ТЗ §4.10)', async () => {
    const { service, jobs } = build();
    const row = await service.run(
      'tutorial-scenario-generate',
      'admin-1',
      false,
    );
    expect(jobs.runTutorialScenarioGenerate).toHaveBeenCalledTimes(1);
    expect(row.status).toBe('SUCCESS');
    expect(row.summary).toContain('generated=9');
  });

  it('tutorial-scenario-run: делегирует CronJobsService.runTutorialScenarioRun (этап 97, §5 ТЗ)', async () => {
    const { service, jobs } = build();
    const row = await service.run('tutorial-scenario-run', 'admin-1', false);
    expect(jobs.runTutorialScenarioRun).toHaveBeenCalledTimes(1);
    expect(row.status).toBe('SUCCESS');
    expect(row.summary).toContain('passed=2');
  });

  // Тот же приём, что cleanup-sessions выше, для нового джоба (см.
  // доккомментарий cron-run-summary.ts): пропуск из-за ненастроенной
  // фикстуры не должен читаться в истории как «0 сценариев вообще».
  it('tutorial-scenario-run: пропуск из-за ненастроенной фикстуры виден в summary', async () => {
    const { service, jobs } = build();
    jobs.runTutorialScenarioRun.mockResolvedValue({
      skipped: 'фикстурный вход не настроен',
      total: 0,
      passed: 0,
      failed: 0,
      outcomes: [],
    });
    const row = await service.run('tutorial-scenario-run', 'admin-1', false);
    expect(row.summary).toContain('фикстурный вход не настроен');
  });

  it('ui-snapshot-run: делегирует CronJobsService.runUiSnapshotRun (этап 100, §3 ТЗ)', async () => {
    const { service, jobs } = build();
    const row = await service.run('ui-snapshot-run', 'admin-1', false);
    expect(jobs.runUiSnapshotRun).toHaveBeenCalledTimes(1);
    expect(row.status).toBe('SUCCESS');
    expect(row.summary).toContain('changed=1');
  });

  // Тот же приём, что у tutorial-scenario-run выше — пропуск из-за
  // ненастроенной фикстуры не должен читаться как «0 маршрутов вообще».
  it('ui-snapshot-run: пропуск из-за ненастроенной фикстуры виден в summary', async () => {
    const { service, jobs } = build();
    jobs.runUiSnapshotRun.mockResolvedValue({
      skipped: 'фикстурный вход не настроен',
      total: 0,
      changed: 0,
      failed: 0,
      outcomes: [],
    });
    const row = await service.run('ui-snapshot-run', 'admin-1', false);
    expect(row.summary).toContain('фикстурный вход не настроен');
  });
});

describe('AdminCronService — sweep-orphans: debug меняет поведение (dryRun)', () => {
  it('без debug: dryRun не передаётся (реальное удаление)', async () => {
    const { service, jobs } = build();
    await service.run('sweep-orphans', 'admin-1', false);
    expect(jobs.runSweepOrphans).toHaveBeenCalledWith({ dryRun: undefined });
  });

  it('с debug: dryRun=1, cursor никогда не передаётся', async () => {
    const { service, jobs } = build();
    await service.run('sweep-orphans', 'admin-1', true);
    expect(jobs.runSweepOrphans).toHaveBeenCalledWith({ dryRun: '1' });
    const call = jobs.runSweepOrphans.mock.calls[0][0];
    expect(call.cursor).toBeUndefined();
  });
});

describe('AdminCronService — провал джоба', () => {
  it('исключение из CronJobsService помечает прогон FAILED с errorMessage', async () => {
    const { service, jobs } = build();
    jobs.runPublish.mockRejectedValueOnce(new Error('YouTube API недоступен'));

    const row = await service.run('publish', 'admin-1', false);

    expect(row.status).toBe('FAILED');
    expect(row.errorMessage).toBe('YouTube API недоступен');
    expect(row.summary).toContain('YouTube API недоступен');
  });

  it('запись истории существует с самого начала (status RUNNING до исхода)', async () => {
    const { service, prisma } = build();
    await service.run('publish', 'admin-1', false);
    expect(prisma.cronRunLog.create).toHaveBeenCalledWith({
      data: {
        jobKey: 'publish',
        triggeredBy: 'admin-1',
        debugMode: false,
        status: 'RUNNING',
      },
    });
  });
});

describe('AdminCronService — история', () => {
  it('getHistory без jobKey отдаёт все, с jobKey — фильтрует', async () => {
    const { service, prisma } = build();
    await service.getHistory();
    expect(prisma.cronRunLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: undefined }),
    );
    await service.getHistory('publish');
    expect(prisma.cronRunLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { jobKey: 'publish' } }),
    );
  });
});
