/**
 * Сводка демо для оператора: что считается успехом крона, что видно в
 * матрице роликов и что НЕ уходит наружу.
 *
 * Журнал кронов здесь — маленькая база в памяти, которая понимает ровно
 * те условия, что пишет сервис (`status`, `summary` startsWith/null/NOT,
 * `OR`, `startedAt lt`): проверять, что «пропуск не успех», на моке,
 * который отвечает одно и то же на любой запрос, бессмысленно.
 */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import {
  CRON_TRIGGERED_BY,
  DEMO_CRON_JOB_KEYS,
  DemoStatusService,
  catalogSubjects,
  isSkippedRun,
} from './demo-status.service';
import { VERCEL_CRON_TRIGGERED_BY } from '../cron/cron-jobs.service';

type Row = Record<string, unknown>;

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([field, cond]) => {
    if (field === 'OR') return (cond as Row[]).some((w) => matches(row, w));
    if (field === 'NOT') return !matches(row, cond as Row);
    const value = row[field];
    if (cond === null) return value === null || value === undefined;
    if (cond instanceof Date) {
      return value instanceof Date && value.getTime() === cond.getTime();
    }
    if (typeof cond === 'object') {
      const c = cond as {
        startsWith?: string;
        lt?: Date;
        gte?: Date;
        not?: null;
      };
      if (c.startsWith !== undefined) {
        return typeof value === 'string' && value.startsWith(c.startsWith);
      }
      if (c.lt !== undefined) return (value as Date) < c.lt;
      if (c.gte !== undefined) return (value as Date) >= c.gte;
      if ('not' in c) return value !== null && value !== undefined;
      return false;
    }
    return value === cond;
  });
}

function pick(row: Row, select?: Row): Row {
  if (!select) return row;
  return Object.fromEntries(Object.keys(select).map((k) => [k, row[k]]));
}

function newestFirst(field: string) {
  return (a: Row, b: Row) =>
    (b[field] as Date).getTime() - (a[field] as Date).getTime();
}

function groupBy(rows: Row[], args: { by: string[]; where: Row }) {
  const groups = new Map<string, Row>();
  for (const row of rows.filter((r) => matches(r, args.where))) {
    const k = args.by.map((f) => row[f]).join('|');
    const g = groups.get(k) ?? {
      ...Object.fromEntries(args.by.map((f) => [f, row[f]])),
      _count: { _all: 0 },
      _max: { createdAt: null as Date | null },
    };
    (g._count as { _all: number })._all += 1;
    const max = g._max as { createdAt: Date | null };
    if (!max.createdAt || (row.createdAt as Date) > max.createdAt) {
      max.createdAt = row.createdAt as Date;
    }
    groups.set(k, g);
  }
  return [...groups.values()];
}

function build(data: { cron?: Row[]; assets?: Row[]; snapshots?: Row[] }) {
  const cron = data.cron ?? [];
  const assets = data.assets ?? [];
  const snapshots = data.snapshots ?? [];
  const prisma = {
    cronRunLog: {
      findFirst: jest.fn(async (args: { where: Row; select?: Row }) => {
        const hit = cron
          .filter((r) => matches(r, args.where))
          .sort(newestFirst('startedAt'))[0];
        return hit ? pick(hit, args.select) : null;
      }),
    },
    tutorialVideoAsset: {
      findMany: jest.fn(async (args: { where: Row; select?: Row }) =>
        assets
          .filter((r) => matches(r, args.where))
          .sort(newestFirst('createdAt'))
          .map((r) => pick(r, args.select)),
      ),
      groupBy: jest.fn(async (args: { by: string[]; where: Row }) =>
        groupBy(assets, args),
      ),
    },
    uiSnapshot: {
      groupBy: jest.fn(async (args: { by: string[]; where: Row }) =>
        groupBy(snapshots, args),
      ),
      findFirst: jest.fn(async (args: { where: Row; select?: Row }) => {
        const hit = snapshots
          .filter((r) => matches(r, args.where))
          .sort(newestFirst('createdAt'))[0];
        return hit ? pick(hit, args.select) : null;
      }),
    },
  };
  return { service: new DemoStatusService(prisma as never), prisma };
}

const NOW = new Date('2026-10-06T12:00:00.000Z');
const at = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * 3600_000);

function run(over: Row): Row {
  return {
    jobKey: 'tutorial-assembly-poll',
    status: 'SUCCESS',
    triggeredBy: CRON_TRIGGERED_BY,
    startedAt: at(1),
    finishedAt: at(1),
    durationMs: 1200,
    summary: 'polled=1',
    errorMessage: null,
    debugLog: null,
    ...over,
  };
}

function asset(over: Row): Row {
  return {
    id: `a_${Math.random()}`,
    subjectKey: '2',
    locale: 'ru',
    reviewed: true,
    assemblyStatus: 'complete',
    clientSiteDraftId: null,
    scenarioId: 'scn_secret',
    blobUrl: 'https://blob/v.mp4',
    externalUrl: null,
    durationMs: 30000,
    width: 720,
    height: 1560,
    posterUrl: 'https://blob/p.png',
    theme: 'light',
    createdAt: at(10),
    capturedAt: at(11),
    captureBuild: 'abc1234',
    ...over,
  };
}

describe('DemoStatusService — кроны', () => {
  it('константа «крон» совпадает с той, что пишет сам крон', () => {
    expect(CRON_TRIGGERED_BY).toBe(VERCEL_CRON_TRIGGERED_BY);
  });

  it('по одной записи на каждый крон демо, в порядке конвейера', async () => {
    const { service } = build({});
    const view = await service.get(NOW);
    expect(view.crons.map((c) => c.jobKey)).toEqual([...DEMO_CRON_JOB_KEYS]);
    expect(view.crons[0]).toEqual({
      jobKey: 'tutorial-scenario-generate',
      lastRun: null,
      lastSuccess: null,
      lastFailure: null,
      lastSkip: null,
    });
  });

  it('пропуск по сводке — не успех; успехом остаётся более старый настоящий', async () => {
    const { service } = build({
      cron: [
        run({ startedAt: at(30), summary: 'polled=2, completed=1' }),
        run({
          startedAt: at(1),
          summary: 'пропущен — предыдущий прогон ещё не завершился',
        }),
      ],
    });
    const poll = (await service.get(NOW)).crons.find(
      (c) => c.jobKey === 'tutorial-assembly-poll',
    )!;
    expect(poll.lastRun?.outcome).toBe('skipped');
    expect(poll.lastSkip?.startedAt).toBe(at(1).toISOString());
    expect(poll.lastSuccess?.outcome).toBe('success');
    expect(poll.lastSuccess?.startedAt).toBe(at(30).toISOString());
  });

  it('пропуск, видный только в debug-результате, — тоже не успех', async () => {
    const { service } = build({
      cron: [
        run({ startedAt: at(50), summary: 'polled=3' }),
        run({
          startedAt: at(2),
          summary: 'polled=0',
          debugLog: { skipped: 'замок занят' },
        }),
      ],
    });
    const poll = (await service.get(NOW)).crons.find(
      (c) => c.jobKey === 'tutorial-assembly-poll',
    )!;
    expect(poll.lastSuccess?.startedAt).toBe(at(50).toISOString());
    expect(poll.lastSkip?.startedAt).toBe(at(2).toISOString());
  });

  it('провал: время, обрезанный текст ошибки, без id оператора', async () => {
    const { service } = build({
      cron: [
        run({
          jobKey: 'tutorial-scenario-run',
          status: 'FAILED',
          triggeredBy: 'usr_operator_42',
          summary: 'Ошибка: x',
          errorMessage: 'E'.repeat(1000),
        }),
      ],
    });
    const runCron = (await service.get(NOW)).crons.find(
      (c) => c.jobKey === 'tutorial-scenario-run',
    )!;
    expect(runCron.lastFailure?.outcome).toBe('failed');
    expect(runCron.lastFailure?.trigger).toBe('manual');
    expect(runCron.lastFailure?.summary!.length).toBeLessThanOrEqual(301);
    expect(JSON.stringify(runCron)).not.toContain('usr_operator_42');
    expect(runCron.lastSuccess).toBeNull();
  });

  it('isSkippedRun: провал и «пропущенных 0» в сводке — не пропуск', () => {
    expect(isSkippedRun({ status: 'FAILED', summary: 'пропущен — x' })).toBe(
      false,
    );
    expect(
      isSkippedRun({ status: 'SUCCESS', summary: 'done=1, пропущено 0' }),
    ).toBe(false);
    expect(isSkippedRun({ status: 'SUCCESS', summary: null })).toBe(false);
    expect(
      isSkippedRun({
        status: 'SUCCESS',
        summary: null,
        debugLog: { skipped: true },
      }),
    ).toBe(true);
  });
});

describe('DemoStatusService — матрица роликов', () => {
  it('каждая тема каталога каждой локали — ячейка, даже без роликов', async () => {
    const { service } = build({});
    const view = await service.get(NOW);
    const ru = view.tutorials.cells.filter((c) => c.locale === 'ru');
    expect(ru.length).toBe(catalogSubjects('ru').length);
    expect(ru.some((c) => c.family === 'step')).toBe(true);
    expect(ru.some((c) => c.family === 'greeting')).toBe(true);
    expect(ru.every((c) => c.approved === null && c.pendingReview === 0)).toBe(
      true,
    );
    expect(view.tutorials.locales).toContain('ru');
  });

  it('одобренный: самый свежий, его тема и метаданные; темы всех одобренных', async () => {
    const { service } = build({
      assets: [
        asset({ theme: 'light', createdAt: at(48), captureBuild: 'old0001' }),
        asset({
          theme: 'dark',
          createdAt: at(5),
          capturedAt: at(6),
          captureBuild: 'new0002',
          width: 1920,
          height: 1080,
        }),
      ],
    });
    const cell = (await service.get(NOW)).tutorials.cells.find(
      (c) => c.locale === 'ru' && c.subjectKey === '2',
    )!;
    expect(cell.approved).toEqual({
      theme: 'dark',
      approvedRowCreatedAt: at(5).toISOString(),
      capturedAt: at(6).toISOString(),
      captureBuild: 'new0002',
      durationMs: 30000,
      width: 1920,
      height: 1080,
      hasPoster: true,
    });
    expect(cell.approvedThemes.sort()).toEqual(['dark', 'light']);
  });

  it('матрица по темам: свой одобренный и своя дата съёмки у каждой темы', async () => {
    const { service } = build({
      assets: [
        asset({
          theme: 'light',
          createdAt: at(48),
          capturedAt: at(49),
          captureBuild: 'light01',
        }),
        // Более старый светлый — не «одобренный светлой».
        asset({ theme: 'light', createdAt: at(72), captureBuild: 'light00' }),
        asset({
          theme: 'dark',
          createdAt: at(5),
          capturedAt: at(6),
          captureBuild: 'dark001',
        }),
        // Тёмный ждёт одобрения — в очередь тёмной, не светлой.
        asset({ theme: 'dark', reviewed: false, createdAt: at(1) }),
        asset({ theme: 'light', reviewed: false, createdAt: at(2) }),
        asset({ theme: 'light', reviewed: false, createdAt: at(3) }),
      ],
    });
    const view = await service.get(NOW);
    const cell = view.tutorials.cells.find(
      (c) => c.locale === 'ru' && c.subjectKey === '2',
    )!;
    expect(cell.byTheme.light.approved).toEqual(
      expect.objectContaining({
        theme: 'light',
        approvedRowCreatedAt: at(48).toISOString(),
        capturedAt: at(49).toISOString(),
        captureBuild: 'light01',
      }),
    );
    expect(cell.byTheme.dark.approved).toEqual(
      expect.objectContaining({
        theme: 'dark',
        capturedAt: at(6).toISOString(),
        captureBuild: 'dark001',
      }),
    );
    expect(cell.byTheme.light.pendingReview).toBe(2);
    expect(cell.byTheme.dark.pendingReview).toBe(1);
    expect(cell.pendingReview).toBe(3);
    // Верхний «что увидит посетитель» — самый свежий любой темы.
    expect(cell.approved?.theme).toBe('dark');
    expect(view.tutorials.totals.withApprovedByTheme).toEqual({
      light: 1,
      dark: 1,
    });
    // Ячейка без роликов — обе темы пусты, а не отсутствуют.
    const empty = view.tutorials.cells.find(
      (c) => c.locale === 'ru' && c.subjectKey === '1',
    )!;
    expect(empty.byTheme).toEqual({
      light: { approved: null, pendingReview: 0 },
      dark: { approved: null, pendingReview: 0 },
    });
  });

  it('ролик без темы (до тем) — в столбце светлой', async () => {
    const { service } = build({
      assets: [
        asset({ theme: null }),
        asset({ theme: null, reviewed: false, createdAt: at(1) }),
      ],
    });
    const cell = (await service.get(NOW)).tutorials.cells.find(
      (c) => c.locale === 'ru' && c.subjectKey === '2',
    )!;
    expect(cell.approvedThemes).toEqual([null]);
    expect(cell.byTheme.light.approved).not.toBeNull();
    expect(cell.byTheme.light.pendingReview).toBe(1);
    expect(cell.byTheme.dark.approved).toBeNull();
  });

  it('ожидающие одобрения считаются; неодобренный не становится «одобренным»', async () => {
    const { service } = build({
      assets: [
        asset({ reviewed: false, createdAt: at(1) }),
        asset({ reviewed: false, createdAt: at(2) }),
        // Сборка не завершена — одобрять пока нечего.
        asset({ reviewed: false, assemblyStatus: 'pending' }),
      ],
    });
    const view = await service.get(NOW);
    const cell = view.tutorials.cells.find(
      (c) => c.locale === 'ru' && c.subjectKey === '2',
    )!;
    expect(cell.approved).toBeNull();
    expect(cell.pendingReview).toBe(2);
    expect(view.tutorials.totals.pendingReview).toBe(2);
  });

  it('ролики обучалки по сайтам заказчиков в сводку не попадают', async () => {
    const { service, prisma } = build({
      assets: [asset({ clientSiteDraftId: 'draft_1', subjectKey: 'client-x' })],
    });
    const view = await service.get(NOW);
    expect(view.tutorials.cells.some((c) => c.subjectKey === 'client-x')).toBe(
      false,
    );
    expect(
      prisma.tutorialVideoAsset.findMany.mock.calls[0][0].where
        .clientSiteDraftId,
    ).toBeNull();
    expect(
      prisma.tutorialVideoAsset.groupBy.mock.calls[0][0].where
        .clientSiteDraftId,
    ).toBeNull();
  });

  it('ключ вне каталога — отдельной ячейкой «other», а не молча', async () => {
    const { service } = build({
      assets: [asset({ subjectKey: 'workflow-x' })],
    });
    const cell = (await service.get(NOW)).tutorials.cells.find(
      (c) => c.subjectKey === 'workflow-x',
    );
    expect(cell?.family).toBe('other');
    expect(cell?.approved).not.toBeNull();
  });

  it('наружу — ни id строки, ни сценария, ни ссылки на ролик', async () => {
    const { service } = build({ assets: [asset({})] });
    const text = JSON.stringify((await service.get(NOW)).tutorials);
    expect(text).not.toContain('scn_secret');
    expect(text).not.toContain('https://blob/v.mp4');
    expect(text).not.toContain('"id"');
  });
});

describe('DemoStatusService — снимки интерфейса', () => {
  it('последний снимок каждой комбинации и время последнего удачного', async () => {
    const snap = (over: Row): Row => ({
      routeKey: 'home',
      locale: 'ru',
      theme: 'light',
      changed: false,
      diffScore: 0.01,
      error: null,
      blobUrl: 'https://blob/s.png',
      comparedToUrl: null,
      createdAt: at(1),
      ...over,
    });
    const { service } = build({
      snapshots: [
        snap({ createdAt: at(3) }),
        snap({ createdAt: at(1), error: 'navigation timeout', blobUrl: null }),
        snap({ theme: 'dark', createdAt: at(2), changed: true }),
        // Старше окна — не «последний снимок».
        snap({ routeKey: 'gone', createdAt: at(24 * 40) }),
      ],
    });
    const view = await service.get(NOW);
    expect(view.uiSnapshots.items).toEqual([
      {
        routeKey: 'home',
        locale: 'ru',
        theme: 'dark',
        lastAt: at(2).toISOString(),
        lastOkAt: at(2).toISOString(),
        changed: true,
        diffScore: 0.01,
        error: null,
        imageUrl: 'https://blob/s.png',
      },
      {
        routeKey: 'home',
        locale: 'ru',
        theme: 'light',
        lastAt: at(1).toISOString(),
        lastOkAt: at(3).toISOString(),
        changed: false,
        diffScore: 0.01,
        error: 'navigation timeout',
        imageUrl: null,
      },
    ]);
  });
});
