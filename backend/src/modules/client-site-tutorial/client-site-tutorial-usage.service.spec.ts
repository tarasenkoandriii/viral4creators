/* eslint-disable @typescript-eslint/no-explicit-any -- тестовые дублёры */
/**
 * Дневные лимиты визарда обучалки по сайту заказчика (§9 ТЗ, этап 111).
 *
 * Проверяется ровно то же, что и у квот SerpApi/YouTube в
 * `product-analog/usage-quota.spec.ts`, и ровно по той же причине: фраза
 * «перерасход невозможен» в комментарии верна только пока условие
 * `WHERE ... < limit` стоит ВНУТРИ единственного запроса. Убери его — и
 * ни один тест вызывающего сервиса этого не заметит, потому что там
 * счётчик подменён целиком.
 *
 * Отдельно проверяется, что раунды и live-сессии — две НЕЗАВИСИМЫЕ
 * колонки одной строки: перепутанная колонка означала бы, что десять
 * дешёвых раундов закрывают дорогой живой вход (или наоборот).
 */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import {
  ClientSiteTutorialUsageService,
  DEFAULT_LIVE_SESSIONS_PER_DAY,
  DEFAULT_ROUNDS_PER_DAY,
} from './client-site-tutorial-usage.service';

const env = { ...process.env };
afterEach(() => {
  process.env = { ...env };
});

const TABLE = 'client_site_tutorial_usage';
const NOW = new Date('2026-09-09T23:30:00Z');
const DAY = '2026-09-09';

function build(affected: number) {
  const prisma = { $executeRaw: jest.fn().mockResolvedValue(affected) };
  return {
    svc: new ClientSiteTutorialUsageService(prisma as any),
    prisma,
  };
}

function sqlOf(prisma: { $executeRaw: jest.Mock }): string {
  return (prisma.$executeRaw.mock.calls[0][0] as string[]).join('?');
}

function paramsOf(prisma: { $executeRaw: jest.Mock }): unknown[] {
  return prisma.$executeRaw.mock.calls[0].slice(1) as unknown[];
}

const CASES = [
  {
    name: 'раунды',
    column: 'rounds',
    envKey: 'SITE_TUTORIAL_ROUNDS_PER_DAY',
    fallback: DEFAULT_ROUNDS_PER_DAY,
    reserve: (s: ClientSiteTutorialUsageService, u: string, now?: Date) =>
      s.reserveRound(u, now),
    release: (s: ClientSiteTutorialUsageService, u: string, now?: Date) =>
      s.releaseRound(u, now),
  },
  {
    name: 'live-сессии',
    column: 'liveSessions',
    envKey: 'SITE_TUTORIAL_LIVE_SESSIONS_PER_DAY',
    fallback: DEFAULT_LIVE_SESSIONS_PER_DAY,
    reserve: (s: ClientSiteTutorialUsageService, u: string, now?: Date) =>
      s.reserveLiveSession(u, now),
    release: (s: ClientSiteTutorialUsageService, u: string, now?: Date) =>
      s.releaseLiveSession(u, now),
  },
];

describe.each(CASES)('$name — слот занимается одним условным запросом', (c) => {
  it('слот занят → true, лимит выбран → false, без исключений', async () => {
    const ok = build(1);
    expect(await c.reserve(ok.svc, 'u1')).toBe(true);
    const full = build(0);
    expect(await c.reserve(full.svc, 'u1')).toBe(false);
  });

  it('условие по лимиту стоит В САМОМ запросе, а не читается отдельно', async () => {
    process.env[c.envKey] = '7';
    const { svc, prisma } = build(1);
    await c.reserve(svc, 'u1', NOW);

    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    const sql = sqlOf(prisma);
    expect(sql).toContain(`INSERT INTO "${TABLE}"`);
    expect(sql).toContain('ON CONFLICT ("userId", "day") DO UPDATE');
    expect(sql).toContain(`WHERE "${TABLE}"."${c.column}" < ?`);

    const params = paramsOf(prisma);
    expect(params[params.length - 1]).toBe(7);
    expect(params).toContain('u1');
    // Ключ суток — UTC-дата строкой: 23:30 UTC остаётся тем же днём, а не
    // уезжает в следующий из-за локальной таймзоны контейнера.
    expect(params).toContain(DAY);
  });

  it('увеличивается ИМЕННО своя колонка — иначе один лимит съедал бы другой', async () => {
    const { svc, prisma } = build(1);
    await c.reserve(svc, 'u1');
    const sql = sqlOf(prisma);
    expect(sql).toContain(`SET "${c.column}" = "${TABLE}"."${c.column}" + 1`);
  });

  it('без переменной берётся умолчание, а не ноль и не бесконечность', async () => {
    delete process.env[c.envKey];
    const { svc, prisma } = build(1);
    await c.reserve(svc, 'u1');
    const params = paramsOf(prisma);
    expect(params[params.length - 1]).toBe(c.fallback);
  });

  it('мусор в переменной не вырождает условие', async () => {
    // `< 0` закрыл бы визард всем, `< NaN` — не закрыл бы никому.
    for (const bad of ['0', '-5', 'abc', '', '1.5']) {
      process.env[c.envKey] = bad;
      const { svc, prisma } = build(1);
      await c.reserve(svc, 'u1');
      expect(paramsOf(prisma)[paramsOf(prisma).length - 1]).toBe(c.fallback);
    }
  });

  it('возврат слота не опускает счётчик ниже нуля', async () => {
    // Двойной release (раунд упал, а потом упала и уборка) не должен
    // дарить пользователю квоту.
    const { svc, prisma } = build(1);
    await c.release(svc, 'u1', NOW);
    const sql = sqlOf(prisma);
    expect(sql).toContain(`UPDATE "${TABLE}"`);
    expect(sql).toContain(`GREATEST("${c.column}" - 1, 0)`);
    expect(paramsOf(prisma)).toEqual(['u1', DAY]);
  });
});

describe('остаток на экране визарда', () => {
  function withRow(row: { rounds: number; liveSessions: number } | null) {
    process.env.SITE_TUTORIAL_ROUNDS_PER_DAY = '10';
    process.env.SITE_TUTORIAL_LIVE_SESSIONS_PER_DAY = '3';
    const prisma = {
      clientSiteTutorialUsage: {
        findUnique: jest.fn().mockResolvedValue(row),
      },
    };
    return {
      svc: new ClientSiteTutorialUsageService(prisma as any),
      prisma,
    };
  }

  it('строка есть — обе колонки отдаются вместе со своими лимитами', async () => {
    const { svc } = withRow({ rounds: 7, liveSessions: 1 });
    expect(await svc.snapshot('u1')).toEqual({
      rounds: 7,
      liveSessions: 1,
      roundsLimit: 10,
      liveSessionsLimit: 3,
    });
  });

  it('строки нет — нули, а не падение', async () => {
    const { svc } = withRow(null);
    expect(await svc.snapshot('u1')).toEqual({
      rounds: 0,
      liveSessions: 0,
      roundsLimit: 10,
      liveSessionsLimit: 3,
    });
  });

  it('читается строка ровно за сегодняшние UTC-сутки этого пользователя', async () => {
    const { svc, prisma } = withRow(null);
    await svc.snapshot('u1', NOW);
    expect(prisma.clientSiteTutorialUsage.findUnique).toHaveBeenCalledWith({
      where: { userId_day: { userId: 'u1', day: DAY } },
    });
  });
});
