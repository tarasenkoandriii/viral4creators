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
import { AdminCronService, SCHEDULE_CHANGE_SCAN } from './admin-cron.service';

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
    runApiVideo: jest.fn().mockResolvedValue({
      started: 1,
      completed: 0,
      failed: 0,
      running: 0,
      delivered: 0,
      retried: 0,
      gaveUp: 0,
    }),
    runBalancesWatch: jest.fn().mockResolvedValue({
      watched: 2,
      low: 1,
      unreadable: 0,
      notified: 1,
      skippedUnused: 0,
    }),
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
    runAiUsageRollup: jest.fn().mockResolvedValue({
      months: ['2026-01'],
      foldedRows: 12,
      deletedRows: 3400,
    }),
    runCleanupSessions: jest
      .fn()
      .mockResolvedValue({ deletedCount: 7, deletedBlobs: 3 }),
    runVoiceUploadsSweep: jest
      .fn()
      .mockResolvedValue({ deleted: 2, failed: 0, hasMore: false }),
    runPersonaSourcesPurge: jest
      .fn()
      .mockResolvedValue({ purged: 1, abandoned: 0, failed: 0 }),
    runClientSiteRetention: jest.fn().mockResolvedValue({
      secretsExpired: 0,
      secretsOneShot: 0,
      framesPurged: 0,
      framesFailed: 0,
    }),
    runSweepOrphans: jest
      .fn()
      .mockResolvedValue({ deleted: 0, dryRun: false, byKind: {} }),
    // Джобы маркетплейса и живого эфира. Их не было в этом моке, хотя в
    // реестре они уже стояли: именно поэтому проверка ниже считала
    // пятнадцать джобов вместо двадцати.
    runAuctionClose: jest.fn().mockResolvedValue({ closed: 2 }),
    runAuctionAssess: jest.fn().mockResolvedValue({ assessed: 1 }),
    runAuctionGoogleAdsSync: jest
      .fn()
      .mockResolvedValue({ paused: 1, stillStuck: 0 }),
    runPortfolioWatermark: jest
      .fn()
      .mockResolvedValue({ processed: 3, failed: 0 }),
    runLiveAuctionTick: jest.fn().mockResolvedValue({ ticked: 4 }),
    // Сквозной аудит 27.09.2026 (находка Д-2): отдельный опрос сборок
    // слайд-шоу обучалки.
    runTutorialAssemblyPoll: jest.fn().mockResolvedValue({ pending: 2 }),
  };
  const service = new AdminCronService(jobs as never, prisma as never);
  return { service, jobs, prisma };
}

describe('AdminCronService — реестр и неизвестный jobKey', () => {
  // Было: `toHaveLength(15)`. Такая проверка ломается при каждом новом
  // джобе и при этом ничего не гарантирует — реестр из пятнадцати
  // неработающих ключей её бы прошёл. Проверяем то, ради чего реестр
  // существует: КАЖДЫЙ объявленный в нём ключ действительно доходит до
  // CronJobsService. Джоб, добавленный в реестр и забытый в switch
  // `dispatch()`, попадёт в ветку default и упадёт 400-й — оператор
  // увидит кнопку, которая не работает.
  it('каждый джоб реестра реально диспетчеризуется, а не падает в default', async () => {
    const { service, jobs } = build();
    const registry = service.getRegistry();
    expect(registry.length).toBeGreaterThan(0);

    for (const { jobKey } of registry) {
      const row = await service.run(jobKey, 'admin-1', false);
      expect(row.status).toBe('SUCCESS');
    }

    // И наоборот: у каждого вызванного джоба сработал ровно один метод
    // сервиса — то есть ни один ключ не «проглочен» чужой веткой.
    const called = Object.values(jobs).filter(
      (fn) => (fn as jest.Mock).mock.calls.length > 0,
    );
    expect(called).toHaveLength(registry.length);
  });

  it('ключи реестра уникальны и у каждого есть описание для админки', () => {
    const { service } = build();
    const registry = service.getRegistry();
    const keys = registry.map((j) => j.jobKey);

    expect(new Set(keys).size).toBe(keys.length);
    for (const job of registry) {
      expect(job.description.trim().length).toBeGreaterThan(0);
    }
  });

  it('джобы аукциона и живого эфира есть в реестре', () => {
    // Якорь на конкретные ключи вместо счётчика: их отсутствие означает,
    // что лоты не закрываются по дедлайну, а эфир не тикает.
    const { service } = build();
    const keys = service.getRegistry().map((j) => j.jobKey);
    expect(keys).toEqual(
      expect.arrayContaining([
        'auction-close',
        'auction-assess',
        'auction-google-ads-sync',
        'live-auction-tick',
        'portfolio-watermark',
      ]),
    );
  });

  it('свёртка журнала расходов есть в реестре и диспетчеризуется (этап 118)', async () => {
    // Джоб, которого нет в реестре, нельзя запустить из админки вовсе —
    // а руками его никто не запустит: это фоновая уборка.
    const { service, jobs } = build();
    expect(service.getRegistry().map((j) => j.jobKey)).toContain(
      'ai-usage-rollup',
    );
    await service.run('ai-usage-rollup', 'admin-1', false);
    expect(jobs.runAiUsageRollup).toHaveBeenCalledTimes(1);
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
    // И исход — «пропущен», а не «успех» (аудит кронов 06.10.2026).
    expect(row.status).toBe('SUCCESS');
    expect(row.outcome).toBe('SKIPPED');
    expect(row.debugLog).toMatchObject({
      cronOutcome: 'SKIPPED',
      reason: 'фикстурный вход не настроен',
    });
  });

  it('обычный успех — исхода «пропущен» нет', async () => {
    const { service } = build();
    const row = await service.run('tutorial-scenario-run', 'admin-1', false);
    expect(row.outcome).toBeNull();
    expect(row.debugLog).toBeUndefined();
  });

  it('tutorial-assembly-poll: делегирует CronJobsService.runTutorialAssemblyPoll (аудит 27.09.2026, Д-2)', async () => {
    const { service, jobs } = build();
    const row = await service.run('tutorial-assembly-poll', 'admin-1', false);
    expect(jobs.runTutorialAssemblyPoll).toHaveBeenCalledTimes(1);
    // И главное — что это НЕ общий прогон сценариев: тот держит
    // headless-браузер минутами, ради чего слот и разделён.
    expect(jobs.runTutorialScenarioRun).not.toHaveBeenCalled();
    expect(row.status).toBe('SUCCESS');
    expect(row.summary).toContain('pending=2');
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
      expect.objectContaining({ where: {}, take: 50 }),
    );
    await service.getHistory({ jobKey: 'publish' });
    expect(prisma.cronRunLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { jobKey: 'publish' } }),
    );
  });
});

describe('AdminCronService — история за период и постранично', () => {
  it('since/until → startedAt [gte, lt), limit, стабильный порядок', async () => {
    const { service, prisma } = build();
    const since = new Date('2026-09-29T00:00:00Z');
    const until = new Date('2026-09-30T00:00:00Z');
    await service.getHistory({ jobKey: 'publish', since, until, limit: 500 });
    expect(prisma.cronRunLog.findMany).toHaveBeenCalledWith({
      where: { jobKey: 'publish', startedAt: { gte: since, lt: until } },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      take: 500,
    });
  });

  it('before → курсор Prisma с пропуском самой строки-курсора', async () => {
    const { service, prisma } = build();
    await service.getHistory({ before: 'row-9' });
    expect(prisma.cronRunLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: { id: 'row-9' }, skip: 1 }),
    );
  });

  it('limit сверх потолка режется и в самом сервисе', async () => {
    const { service, prisma } = build();
    await service.getHistory({ limit: 100000 });
    expect(prisma.cronRunLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 500 }),
    );
  });
});

describe('AdminCronService — сводка за период', () => {
  const since = new Date('2026-09-29T00:00:00Z');
  const until = new Date('2026-09-30T00:00:00Z');
  const now = new Date('2026-09-30T12:00:00Z');

  function buildSummary(opts: {
    groups: unknown[];
    medians?: unknown[];
    stuck?: unknown[];
    window?: unknown[];
    first?: unknown[];
    failures?: unknown[];
    outcomes?: unknown[];
    /** Прогоны по расписанию для проверки смены расписания (заход 7);
     *  `schedule` — записанное у прогона выражение (null — старая строка). */
    runs?: Array<{ jobKey: string; startedAt: Date; schedule?: string | null }>;
  }) {
    // Прогоны в окне — группами по (jobKey, schedule), как их отдаёт
    // groupBy базы: из `runs` (без `schedule` — строка до колонки), а у
    // джобов из `window` без `runs` — одной группой без выражения.
    const windowGroups = () => {
      const out = new Map<
        string,
        {
          jobKey: string;
          schedule: string | null;
          _count: { _all: number };
          _max: { startedAt: Date | null };
        }
      >();
      for (const r of opts.runs ?? []) {
        const schedule = r.schedule ?? null;
        const key = `${r.jobKey}\u0000${schedule}`;
        const g = out.get(key) ?? {
          jobKey: r.jobKey,
          schedule,
          _count: { _all: 0 },
          _max: { startedAt: null },
        };
        g._count._all += 1;
        if (!g._max.startedAt || g._max.startedAt < r.startedAt) {
          g._max.startedAt = r.startedAt;
        }
        out.set(key, g);
      }
      const withRuns = new Set((opts.runs ?? []).map((r) => r.jobKey));
      for (const w of (opts.window ?? []) as Array<{
        jobKey: string;
        _count: { _all: number };
      }>) {
        if (withRuns.has(w.jobKey)) continue;
        out.set(w.jobKey, {
          jobKey: w.jobKey,
          schedule: null,
          _count: { _all: w._count._all },
          _max: { startedAt: null },
        });
      }
      return [...out.values()];
    };
    const groupBy = jest.fn(
      (args: {
        by: string[];
        where: Record<string, unknown>;
        _min?: unknown;
      }) =>
        Promise.resolve(
          args.by.includes('schedule')
            ? windowGroups()
            : args.by.length > 1
              ? opts.groups
              : args._min
                ? (opts.first ?? [])
                : (opts.stuck ?? []),
        ),
    );
    const prisma = {
      cronRunLog: {
        groupBy,
        findMany: jest.fn(
          (args: {
            where: { jobKey?: string; status?: string; schedule?: null };
            orderBy?: { startedAt?: string };
            take?: number;
          }) => {
            if (args.where.status === 'FAILED') {
              return Promise.resolve(opts.failures ?? []);
            }
            const rows = (opts.runs ?? [])
              .filter((r) => r.jobKey === args.where.jobKey)
              .filter(
                (r) =>
                  !('schedule' in args.where) || (r.schedule ?? null) === null,
              )
              .sort((a, b) =>
                args.orderBy?.startedAt === 'desc'
                  ? b.startedAt.getTime() - a.startedAt.getTime()
                  : a.startedAt.getTime() - b.startedAt.getTime(),
              );
            return Promise.resolve(
              args.take === undefined ? rows : rows.slice(0, args.take),
            );
          },
        ),
        // Первый прогон после последнего «чужого».
        findFirst: jest.fn(
          (args: {
            where: { jobKey: string; startedAt: { gt: Date } };
            orderBy: { startedAt: 'asc' };
          }) =>
            Promise.resolve(
              (opts.runs ?? [])
                .filter(
                  (r) =>
                    r.jobKey === args.where.jobKey &&
                    r.startedAt > args.where.startedAt.gt,
                )
                .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())
                .map((r) => ({ startedAt: r.startedAt }))[0] ?? null,
            ),
        ),
        // Прогоны в окне после смены — счётом базы (заход 7, аудит).
        count: jest.fn(
          (args: {
            where: { jobKey: string; startedAt: { gte: Date; lt: Date } };
          }) =>
            Promise.resolve(
              (opts.runs ?? []).filter(
                (r) =>
                  r.jobKey === args.where.jobKey &&
                  r.startedAt >= args.where.startedAt.gte &&
                  r.startedAt < args.where.startedAt.lt,
              ).length,
            ),
        ),
      },
      // Два сырых запроса: медианы и исходы (пропуски, последний успех
      // и провал — аудит кронов 06.10.2026). Различаются по тексту.
      $queryRaw: jest.fn((strings: TemplateStringsArray) =>
        Promise.resolve(
          strings.join('?').includes('lastSuccessAt')
            ? (opts.outcomes ?? [])
            : (opts.medians ?? []),
        ),
      ),
    };
    const service = new AdminCronService({} as never, prisma as never);
    return { service, prisma };
  }

  it('пропуски, последний НАСТОЯЩИЙ успех и последний провал — по джобу (аудит кронов 06.10.2026)', async () => {
    const lastOk = new Date('2026-09-27T09:05:12Z');
    const lastFail = new Date('2026-09-29T10:05:00Z');
    const { service, prisma } = buildSummary({
      groups: [
        {
          jobKey: 'tutorial-scenario-run',
          status: 'SUCCESS',
          triggeredBy: 'vercel-cron',
          _count: { _all: 15 },
          _max: { durationMs: 900 },
        },
      ],
      outcomes: [
        {
          jobKey: 'tutorial-scenario-run',
          skipped: BigInt(15),
          lastSuccessAt: lastOk,
          lastFailureAt: lastFail.toISOString(),
        },
      ],
    });
    const s = await service.getSummary({ since, until }, now);
    const job = s.jobs.find((j) => j.jobKey === 'tutorial-scenario-run');
    expect(job).toMatchObject({
      byStatus: { SUCCESS: 15, FAILED: 0, RUNNING: 0 },
      skipped: 15,
      lastSuccessAt: lastOk,
      lastFailureAt: lastFail,
    });
    // Джоб без строк — нули и null, а не undefined.
    expect(s.jobs.find((j) => j.jobKey === 'report')).toMatchObject({
      skipped: 0,
      lastSuccessAt: null,
      lastFailureAt: null,
    });
    // Запрос отсекает пропуски от «успеха» и ограничен концом периода.
    const call = prisma.$queryRaw.mock.calls.find(([strings]) =>
      (strings as unknown as string[]).join('?').includes('lastSuccessAt'),
    )!;
    const sql = (call[0] as unknown as string[]).join('?');
    expect(sql).toMatch(/IS DISTINCT FROM \?/);
    expect(sql).toMatch(/"startedAt" < \?/);
    expect(call.slice(1)).toEqual(
      expect.arrayContaining(['SKIPPED', since, until]),
    );
  });

  it('ожидалось по vercel.json vs было, статусы, длительности', async () => {
    const { service } = buildSummary({
      groups: [
        {
          jobKey: 'api-video',
          status: 'SUCCESS',
          triggeredBy: 'vercel-cron',
          _count: { _all: 700 },
          _max: { durationMs: 1200 },
        },
        {
          jobKey: 'api-video',
          status: 'FAILED',
          triggeredBy: 'vercel-cron',
          _count: { _all: 5 },
          _max: { durationMs: 9000 },
        },
        {
          jobKey: 'api-video',
          status: 'SUCCESS',
          triggeredBy: 'operator-1',
          _count: { _all: 2 },
          _max: { durationMs: 300 },
        },
      ],
      medians: [{ jobKey: 'api-video', median: 410.5 }],
      // В окне ожидания — 700 из 705: пять прогонов стартовали вне окна.
      window: [{ jobKey: 'api-video', _count: { _all: 700 } }],
      failures: [{ id: 'f1', summary: 'Ошибка: x', errorMessage: 'x' }],
    });
    const s = await service.getSummary({ since, until }, now);
    const job = s.jobs.find((j) => j.jobKey === 'api-video');
    expect(job).toMatchObject({
      schedule: '*/2 * * * *',
      expected: 720,
      scheduledRuns: 705,
      scheduledRunsInWindow: 700,
      manualRuns: 2,
      missed: 20,
      total: 707,
      byStatus: { SUCCESS: 702, FAILED: 5, RUNNING: 0 },
      medianDurationMs: 411,
      maxDurationMs: 9000,
      stuck: false,
      recentFailures: [{ id: 'f1', summary: 'Ошибка: x', errorMessage: 'x' }],
    });
    // Джоб без прогонов всё равно в сводке — с ожиданием и missed.
    const report = s.jobs.find((j) => j.jobKey === 'report');
    expect(report).toMatchObject({ expected: 1, scheduledRuns: 0, missed: 1 });
    expect(s.schedulesLoaded).toBe(true);
    expect(s.lockMs).toBe(11 * 60 * 1000);
  });

  it('последние неуспешные запрашиваются только у джобов с FAILED', async () => {
    const { service, prisma } = buildSummary({
      groups: [
        {
          jobKey: 'publish',
          status: 'FAILED',
          triggeredBy: 'vercel-cron',
          _count: { _all: 1 },
          _max: { durationMs: 10 },
        },
      ],
    });
    await service.getSummary({ since, until }, now);
    expect(prisma.cronRunLog.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.cronRunLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          jobKey: 'publish',
          status: 'FAILED',
          startedAt: { gte: since, lt: until },
        },
        take: 5,
      }),
    );
  });

  it('текущие сутки: ожидание — до now минус запас, окно в ответе', async () => {
    const { service, prisma } = buildSummary({ groups: [] });
    const s = await service.getSummary(
      {
        since: new Date('2026-09-30T00:00:00Z'),
        until: new Date('2026-10-01T00:00:00Z'),
      },
      now,
    );
    // now 12:00 − 3 мин запаса = 11:57; тики */2 в [00:00, 11:57) — 359.
    expect(s.expectedUntil).toEqual(new Date('2026-09-30T11:57:00Z'));
    expect(s.expectedGraceMs).toBe(3 * 60_000);
    expect(s.jobs.find((j) => j.jobKey === 'api-video')?.expected).toBe(359);
    // Строки для сравнения берутся из того же окна.
    expect(prisma.cronRunLog.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ['jobKey', 'schedule'],
        where: {
          triggeredBy: 'vercel-cron',
          startedAt: {
            gte: new Date('2026-09-30T00:00:00Z'),
            lt: new Date('2026-09-30T11:57:00Z'),
          },
        },
      }),
    );
  });

  it('сразу после тика ложного missed нет', async () => {
    // Тик 12:00 ещё не записан (now 12:00:05): он вне окна ожидания.
    const { service } = buildSummary({
      groups: [],
      window: [{ jobKey: 'api-video', _count: { _all: 359 } }],
    });
    const s = await service.getSummary(
      {
        since: new Date('2026-09-30T00:00:00Z'),
        until: new Date('2026-10-01T00:00:00Z'),
      },
      new Date('2026-09-30T12:00:05Z'),
    );
    // 12:00:05 − 3 мин = 11:57:05 → вверх до 11:58 → тики до 11:56 — 359.
    expect(s.jobs.find((j) => j.jobKey === 'api-video')).toMatchObject({
      expected: 359,
      missed: 0,
    });
  });

  it('начало окна — не раньше срока хранения журнала', async () => {
    const { service } = buildSummary({ groups: [] });
    const s = await service.getSummary(
      {
        since: new Date('2026-08-30T00:00:00Z'),
        until: new Date('2026-09-02T00:00:00Z'),
      },
      now,
    );
    // now 2026-09-30T12:00 − 30 дней = 2026-08-31T12:00.
    expect(s.expectedSince).toEqual(new Date('2026-08-31T12:00:00Z'));
    expect(s.retentionDays).toBe(30);
    // report (0 6 * * *) в [08-31T12:00, 09-02T00:00) — только 1 сентября 06:00.
    expect(s.jobs.find((j) => j.jobKey === 'report')?.expected).toBe(1);
  });

  it('новый крон: ожидание — с минуты его первого прогона', async () => {
    // Выкачен посреди суток: первый прогон в 02:45:07, дальше без пропусков.
    const { service, prisma } = buildSummary({
      groups: [],
      first: [
        {
          jobKey: 'api-video',
          _min: { startedAt: new Date('2026-09-30T02:45:07Z') },
        },
      ],
      window: [{ jobKey: 'api-video', _count: { _all: 276 } }],
    });
    const s = await service.getSummary(
      {
        since: new Date('2026-09-30T00:00:00Z'),
        until: new Date('2026-10-01T00:00:00Z'),
      },
      now,
    );
    // */2 в [02:45, 11:57): 02:46 … 11:56 — 276 тиков.
    const job = s.jobs.find((j) => j.jobKey === 'api-video');
    expect(job).toMatchObject({
      expected: 276,
      missed: 0,
      firstScheduledRunAt: new Date('2026-09-30T02:45:07Z'),
      expectedSinceJob: new Date('2026-09-30T02:45:00Z'),
    });
    // Общее окно сводки не сдвигается.
    expect(s.expectedSince).toEqual(new Date('2026-09-30T00:00:00Z'));
    // Первый прогон ищется за весь срок хранения, а не только в окне.
    expect(prisma.cronRunLog.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ['jobKey'],
        where: {
          triggeredBy: 'vercel-cron',
          startedAt: {
            gte: new Date('2026-08-31T12:00:00Z'),
            lt: new Date('2026-09-30T11:57:00Z'),
          },
        },
        _min: { startedAt: true },
      }),
    );
    // У остальных (первого прогона нет) — ожидание с начала окна.
    expect(s.jobs.find((j) => j.jobKey === 'report')).toMatchObject({
      firstScheduledRunAt: null,
      expectedSinceJob: new Date('2026-09-30T00:00:00Z'),
      missed: 1,
    });
  });

  // Заход 7 (TODO «Сводка кронов»): смена расписания не «пропуски».
  // `tutorial-scenario-run` — нынешнее `5 9-23 * * *`; 30.09 до деплоя
  // тики шли по старому `0 9,10 * * *`.
  describe('смена расписания', () => {
    const day = {
      since: new Date('2026-09-30T00:00:00Z'),
      until: new Date('2026-10-01T00:00:00Z'),
    };
    const at = (hhmm: string) => new Date(`2026-09-30T${hhmm}:04Z`);

    it('прогоны по старому расписанию — ожидание по новому с первого «своего» тика', async () => {
      const runs = ['09:00', '10:00', '16:05', '17:05', '18:05'].map((t) => ({
        jobKey: 'tutorial-scenario-run',
        startedAt: at(t),
      }));
      const { service, prisma } = buildSummary({
        groups: [],
        window: [{ jobKey: 'tutorial-scenario-run', _count: { _all: 5 } }],
        runs,
      });
      const s = await service.getSummary(day, new Date('2026-09-30T18:30:00Z'));
      const job = s.jobs.find((j) => j.jobKey === 'tutorial-scenario-run')!;
      // Без поправки: 9:05…18:05 — 10 ожидаемых против 5 → 5 «пропусков».
      expect(job).toMatchObject({
        scheduleChangedAt: new Date('2026-09-30T16:05:00Z'),
        expectedSinceJob: new Date('2026-09-30T16:05:00Z'),
        expected: 3,
        scheduledRunsInWindow: 3,
        missed: 0,
      });
      expect(prisma.cronRunLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            jobKey: 'tutorial-scenario-run',
            triggeredBy: 'vercel-cron',
          }),
          orderBy: { startedAt: 'desc' },
        }),
      );
    });

    it('после смены настоящий пропуск всё равно виден', async () => {
      const runs = ['09:00', '10:00', '16:05', '18:05'].map((t) => ({
        jobKey: 'tutorial-scenario-run',
        startedAt: at(t),
      }));
      const { service } = buildSummary({
        groups: [],
        window: [{ jobKey: 'tutorial-scenario-run', _count: { _all: 4 } }],
        runs,
      });
      const s = await service.getSummary(day, new Date('2026-09-30T18:30:00Z'));
      expect(
        s.jobs.find((j) => j.jobKey === 'tutorial-scenario-run'),
      ).toMatchObject({ expected: 3, scheduledRunsInWindow: 2, missed: 1 });
    });

    it('все прогоны укладываются в расписание — пропуски как были, смены нет', async () => {
      const runs = ['09:05', '11:05'].map((t) => ({
        jobKey: 'tutorial-scenario-run',
        startedAt: at(t),
      }));
      const { service } = buildSummary({
        groups: [],
        window: [{ jobKey: 'tutorial-scenario-run', _count: { _all: 2 } }],
        runs,
      });
      const s = await service.getSummary(day, new Date('2026-09-30T12:30:00Z'));
      expect(
        s.jobs.find((j) => j.jobKey === 'tutorial-scenario-run'),
      ).toMatchObject({
        scheduleChangedAt: null,
        expected: 4,
        missed: 2,
      });
    });

    it('одиночный «чужой» прогон (старт опоздал больше допуска) — не смена, пропуски не обнуляются', async () => {
      const runs = ['09:05', '10:20', '12:05'].map((t) => ({
        jobKey: 'tutorial-scenario-run',
        startedAt: at(t),
      }));
      const { service } = buildSummary({
        groups: [],
        window: [{ jobKey: 'tutorial-scenario-run', _count: { _all: 3 } }],
        runs,
      });
      const s = await service.getSummary(day, new Date('2026-09-30T14:30:00Z'));
      // 9:05…14:05 — 6 ожидаемых, прогонов 3: три пропуска видны.
      expect(
        s.jobs.find((j) => j.jobKey === 'tutorial-scenario-run'),
      ).toMatchObject({ scheduleChangedAt: null, expected: 6, missed: 3 });
    });

    it('после смены прогоны в окне — счётом базы, а не обрезанной выборкой', async () => {
      const runs = ['09:00', '10:00', '16:05', '17:05', '18:05'].map((t) => ({
        jobKey: 'tutorial-scenario-run',
        startedAt: at(t),
      }));
      const { service, prisma } = buildSummary({
        groups: [],
        window: [{ jobKey: 'tutorial-scenario-run', _count: { _all: 5 } }],
        runs,
      });
      await service.getSummary(day, new Date('2026-09-30T18:30:00Z'));
      expect(prisma.cronRunLog.count).toHaveBeenCalledWith({
        where: expect.objectContaining({
          jobKey: 'tutorial-scenario-run',
          startedAt: {
            gte: new Date('2026-09-30T16:05:00Z'),
            lt: expect.any(Date),
          },
        }),
      });
    });

    it('старт с опозданием на пару минут — свой тик, не смена', async () => {
      const runs = [
        { jobKey: 'tutorial-scenario-run', startedAt: at('09:07') },
        { jobKey: 'tutorial-scenario-run', startedAt: at('10:05') },
      ];
      const { service } = buildSummary({
        groups: [],
        window: [{ jobKey: 'tutorial-scenario-run', _count: { _all: 2 } }],
        runs,
      });
      const s = await service.getSummary(day, new Date('2026-09-30T11:30:00Z'));
      expect(
        s.jobs.find((j) => j.jobKey === 'tutorial-scenario-run'),
      ).toMatchObject({ scheduleChangedAt: null, expected: 3, missed: 1 });
    });

    it('после «чужих» прогонов своих ещё нет — с минуты после последнего чужого', async () => {
      const runs = ['09:00', '10:00'].map((t) => ({
        jobKey: 'tutorial-scenario-run',
        startedAt: at(t),
      }));
      const { service } = buildSummary({
        groups: [],
        window: [{ jobKey: 'tutorial-scenario-run', _count: { _all: 2 } }],
        runs,
      });
      const s = await service.getSummary(day, new Date('2026-09-30T12:30:00Z'));
      expect(
        s.jobs.find((j) => j.jobKey === 'tutorial-scenario-run'),
      ).toMatchObject({
        scheduleChangedAt: new Date('2026-09-30T10:01:00Z'),
        // 10:05, 11:05 и 12:05 (запас 3 мин до 12:27) — все пропущены:
        // молчание после смены видно.
        expected: 3,
        scheduledRunsInWindow: 0,
        missed: 3,
      });
    });

    // TODO «сводка кронов: смену расписания на надмножество старого
    // журнал не видит»: у прогона записано выражение, смена — по тексту.
    describe('по записанному у прогона выражению', () => {
      const CURRENT = '5 9-23 * * *';
      const runsOf = (list: Array<[string, string | null]>) =>
        list.map(([hhmm, schedule]) => ({
          jobKey: 'tutorial-scenario-run',
          startedAt: at(hhmm),
          schedule,
        }));

      it('новое — надмножество старого: старые тики укладываются, но смена видна', async () => {
        // Было `5 9,10 * * *`, стало `5 9-23 * * *`: 09:05 и 10:05 —
        // тики и нового расписания, по тикам смена не видна.
        const runs = runsOf([
          ['09:05', '5 9,10 * * *'],
          ['10:05', '5 9,10 * * *'],
          ['16:05', CURRENT],
          ['17:05', CURRENT],
          ['18:05', CURRENT],
        ]);
        const { service, prisma } = buildSummary({
          groups: [],
          window: [{ jobKey: 'tutorial-scenario-run', _count: { _all: 5 } }],
          runs,
        });
        const s = await service.getSummary(
          day,
          new Date('2026-09-30T18:30:00Z'),
        );
        // Без правки: 9:05…18:05 — 10 ожидаемых против 5 → 5 «пропусков».
        expect(
          s.jobs.find((j) => j.jobKey === 'tutorial-scenario-run'),
        ).toMatchObject({
          scheduleChangedAt: new Date('2026-09-30T16:05:00Z'),
          expectedSinceJob: new Date('2026-09-30T16:05:00Z'),
          expected: 3,
          scheduledRunsInWindow: 3,
          missed: 0,
        });
        // Одна группировка окна: и счёт прогонов, и записанные выражения.
        expect(prisma.cronRunLog.groupBy).toHaveBeenCalledWith({
          by: ['jobKey', 'schedule'],
          where: {
            triggeredBy: 'vercel-cron',
            startedAt: { gte: day.since, lt: expect.any(Date) },
          },
          _count: { _all: true },
          _max: { startedAt: true },
        });
        // Строк без выражения нет — догадка по тикам не читает ничего;
        // начало — первый прогон после последнего по старому выражению.
        expect(prisma.cronRunLog.findMany).not.toHaveBeenCalled();
        expect(prisma.cronRunLog.findFirst).toHaveBeenCalledWith({
          where: {
            jobKey: 'tutorial-scenario-run',
            triggeredBy: 'vercel-cron',
            startedAt: { gt: at('10:05') },
          },
          orderBy: { startedAt: 'asc' },
          select: { startedAt: true },
        });
      });

      it('смена раньше потолка выборки (SCHEDULE_CHANGE_SCAN) — видна за всё окно', async () => {
        // `api-video` (нынешнее `*/2`): двое суток шёл по `*/4` (720
        // прогонов), потом пять суток по `*/2` — 3600 прогонов, больше
        // потолка выборки (2000). Смена берётся из группировки окна, а не
        // из последних 2000 строк.
        const MIN = 60_000;
        const from = Date.parse('2026-09-23T00:00:00Z');
        const changed = Date.parse('2026-09-25T00:00:00Z');
        const to = Date.parse('2026-09-30T00:00:00Z');
        const runs: Array<{
          jobKey: string;
          startedAt: Date;
          schedule: string;
        }> = [];
        for (let t = from; t < changed; t += 4 * MIN) {
          runs.push({
            jobKey: 'api-video',
            startedAt: new Date(t + 4_000),
            schedule: '*/4 * * * *',
          });
        }
        for (let t = changed; t < to; t += 2 * MIN) {
          runs.push({
            jobKey: 'api-video',
            startedAt: new Date(t + 4_000),
            schedule: '*/2 * * * *',
          });
        }
        expect(runs.length - 720).toBeGreaterThan(SCHEDULE_CHANGE_SCAN);
        const { service, prisma } = buildSummary({ groups: [], runs });
        const s = await service.getSummary(
          { since: new Date(from), until: new Date(to) },
          new Date('2026-09-30T00:10:00Z'),
        );
        // Без правки: 7 суток × 720 = 5040 ожидаемых против 4320 → 720
        // ложных «пропусков».
        expect(s.jobs.find((j) => j.jobKey === 'api-video')).toMatchObject({
          scheduleChangedAt: new Date(changed),
          expected: 3600,
          scheduledRunsInWindow: 3600,
          missed: 0,
        });
        expect(prisma.cronRunLog.findMany).not.toHaveBeenCalled();
      });

      it('новое — подмножество старого: смена видна и без «пропусков», пропуск после неё — тоже', async () => {
        // Было `5 * * * *`, стало `5 9-23 * * *`. Старых прогонов больше,
        // чем ожидается по новому, — без правки `missed: 0`, и молчание в
        // 12:05 пряталось за ними.
        const runs = runsOf([
          ...['00', '01', '02', '03', '04', '05', '06', '07', '08'].map(
            (h): [string, string] => [`${h}:05`, '5 * * * *'],
          ),
          ['09:05', CURRENT],
          ['10:05', CURRENT],
          ['11:05', CURRENT],
        ]);
        const { service } = buildSummary({
          groups: [],
          window: [{ jobKey: 'tutorial-scenario-run', _count: { _all: 12 } }],
          runs,
        });
        const s = await service.getSummary(
          day,
          new Date('2026-09-30T12:30:00Z'),
        );
        expect(
          s.jobs.find((j) => j.jobKey === 'tutorial-scenario-run'),
        ).toMatchObject({
          scheduleChangedAt: new Date('2026-09-30T09:05:00Z'),
          expected: 4,
          scheduledRunsInWindow: 3,
          missed: 1,
        });
      });

      it('без изменений: свой текст — свой прогон, опоздавшие старты сменой не считаются', async () => {
        // 10:20 и 11:20 — вне допуска опоздания: по тикам это была бы
        // «смена», но выражение у них нынешнее.
        const runs = runsOf([
          ['09:05', CURRENT],
          ['10:20', CURRENT],
          ['11:20', CURRENT],
        ]);
        const { service } = buildSummary({
          groups: [],
          window: [{ jobKey: 'tutorial-scenario-run', _count: { _all: 3 } }],
          runs,
        });
        const s = await service.getSummary(
          day,
          new Date('2026-09-30T14:30:00Z'),
        );
        expect(
          s.jobs.find((j) => j.jobKey === 'tutorial-scenario-run'),
        ).toMatchObject({ scheduleChangedAt: null, expected: 6, missed: 3 });
      });

      it('та же запись иначе (пробелы, табуляция, ведущий ноль) — не смена, прогоны не читаются', async () => {
        const runs = runsOf([
          ['09:05', ' 05  9-23 *  * * '],
          ['10:05', '5\t9-23 * * *'],
          ['11:05', CURRENT],
        ]);
        const { service, prisma } = buildSummary({
          groups: [],
          window: [{ jobKey: 'tutorial-scenario-run', _count: { _all: 3 } }],
          runs,
        });
        const s = await service.getSummary(
          day,
          new Date('2026-09-30T11:30:00Z'),
        );
        expect(
          s.jobs.find((j) => j.jobKey === 'tutorial-scenario-run'),
        ).toMatchObject({ scheduleChangedAt: null, expected: 3, missed: 0 });
        // Пропусков нет, чужого текста нет — сводка прогоны не читает.
        expect(prisma.cronRunLog.findMany).not.toHaveBeenCalled();
      });
    });

    it('сбой чтения прогонов — сводка как без поправки', async () => {
      const { service, prisma } = buildSummary({
        groups: [],
        window: [{ jobKey: 'tutorial-scenario-run', _count: { _all: 1 } }],
      });
      prisma.cronRunLog.findMany.mockRejectedValueOnce(new Error('db'));
      const s = await service.getSummary(day, new Date('2026-09-30T12:30:00Z'));
      expect(
        s.jobs.find((j) => j.jobKey === 'tutorial-scenario-run'),
      ).toMatchObject({ scheduleChangedAt: null, expected: 4, missed: 3 });
    });
  });

  it('первый прогон раньше окна — ожидание с начала окна (молчание видно)', async () => {
    const { service } = buildSummary({
      groups: [],
      first: [
        {
          jobKey: 'report',
          _min: { startedAt: '2026-09-20T06:00:03.000Z' },
        },
      ],
    });
    const s = await service.getSummary({ since, until }, now);
    expect(s.jobs.find((j) => j.jobKey === 'report')).toMatchObject({
      expected: 1,
      missed: 1,
      expectedSinceJob: since,
    });
  });

  it('первый прогон позже конца окна ожидания — ожидается 0', async () => {
    const { service } = buildSummary({
      groups: [],
      first: [
        {
          jobKey: 'report',
          _min: { startedAt: new Date('2026-09-30T11:58:30Z') },
        },
      ],
    });
    const s = await service.getSummary(
      {
        since: new Date('2026-09-30T00:00:00Z'),
        until: new Date('2026-10-01T00:00:00Z'),
      },
      now,
    );
    expect(s.jobs.find((j) => j.jobKey === 'report')).toMatchObject({
      expected: 0,
      missed: 0,
    });
  });

  it('зависший RUNNING: старше замка JOB_LOCK_MS → stuck', async () => {
    const { service, prisma } = buildSummary({
      groups: [
        {
          jobKey: 'blog',
          status: 'RUNNING',
          triggeredBy: 'vercel-cron',
          _count: { _all: 2 },
          _max: { durationMs: null },
        },
      ],
      stuck: [{ jobKey: 'blog', _count: { _all: 1 } }],
    });
    const recentNow = new Date('2026-09-29T10:00:00Z');
    const s = await service.getSummary({ since, until }, recentNow);
    const blog = s.jobs.find((j) => j.jobKey === 'blog');
    expect(blog).toMatchObject({ stuckRunning: 1, stuck: true });
    expect(prisma.cronRunLog.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ['jobKey'],
        where: {
          status: 'RUNNING',
          startedAt: {
            gte: since,
            lt: new Date(recentNow.getTime() - 11 * 60 * 1000),
          },
        },
      }),
    );
  });

  it('период целиком моложе замка — запрос зависших не делается', async () => {
    const { service, prisma } = buildSummary({ groups: [] });
    const justNow = new Date(since.getTime() + 60_000);
    await service.getSummary({ since, until }, justNow);
    expect(prisma.cronRunLog.groupBy).toHaveBeenCalledTimes(1);
  });

  it('jobKey не из реестра попадает в конец сводки, без расписания', async () => {
    const { service } = buildSummary({
      groups: [
        {
          jobKey: 'legacy-job',
          status: 'SUCCESS',
          triggeredBy: 'vercel-cron',
          _count: { _all: 3 },
          _max: { durationMs: 5 },
        },
      ],
    });
    const s = await service.getSummary({ since, until }, now);
    const last = s.jobs[s.jobs.length - 1];
    expect(last).toMatchObject({
      jobKey: 'legacy-job',
      schedule: null,
      expected: null,
      missed: null,
      total: 3,
    });
  });
});
