/**
 * «Обучалка по сайту: выключатель и суточные потолки» (П-Т9, заход 7):
 * админка показывает то же, что действует у потребителя
 * (`ClientSiteTutorialUsageService`), пишет тем же ключам, проверяет ввод
 * целиком до записи и оставляет след «кто менял».
 */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { BadRequestException } from '@nestjs/common';
import {
  AdminSiteTutorialSettingsService,
  parsePaused,
  parseStoredCap,
  SITE_TUTORIAL_CAP_MAX,
} from './admin-site-tutorial-settings.service';
import {
  ClientSiteTutorialUsageService,
  DEFAULT_GLOBAL_LIVE_SESSIONS_PER_DAY,
  DEFAULT_GLOBAL_ROUNDS_PER_DAY,
} from '../client-site-tutorial/client-site-tutorial-usage.service';

const NOW = new Date('2026-10-07T12:00:00Z');
const AT = new Date('2026-10-07T10:00:00Z');

function setup(stored: Record<string, string> = {}, used = { r: 7, l: 2 }) {
  const rows = new Map<string, { value: string; updatedBy: string | null }>(
    Object.entries(stored).map(([k, v]) => [
      k,
      { value: v, updatedBy: 'op-0' },
    ]),
  );
  const prisma = {
    platformSetting: {
      findMany: jest.fn(async () =>
        [...rows.entries()].map(([key, r]) => ({
          key,
          value: r.value,
          updatedAt: AT,
          updatedBy: r.updatedBy,
        })),
      ),
      findUnique: jest.fn(async ({ where }: { where: { key: string } }) => {
        const r = rows.get(where.key);
        return r ? { key: where.key, value: r.value } : null;
      }),
    },
    $queryRaw: jest.fn(async () => [{ rounds: used.r, live: BigInt(used.l) }]),
  };
  const settings = {
    set: jest.fn(async (key: string, value: string, by?: string) => {
      rows.set(key, { value, updatedBy: by ?? null });
    }),
  };
  const service = new AdminSiteTutorialSettingsService(
    prisma as never,
    settings as never,
  );
  service.env = {};
  return { service, prisma, settings, rows };
}

describe('грамматика — та же, что у потребителя', () => {
  it('выключатель и потолок', () => {
    for (const v of ['true', '1', 'ON', ' yes '])
      expect(parsePaused(v)).toBe(true);
    for (const v of ['false', '0', '', null, 'нет']) {
      expect(parsePaused(v)).toBe(false);
    }
    expect(parseStoredCap('300')).toBe(300);
    for (const v of ['', ' ', '0', '-5', '2.5', 'abc', null]) {
      expect(parseStoredCap(v)).toBeNull();
    }
  });

  it('что показывает админка — то и действует у ClientSiteTutorialUsageService', async () => {
    const cases: Array<Record<string, string>> = [
      {},
      { site_tutorial_global_rounds_per_day: '1234' },
      { site_tutorial_global_rounds_per_day: '' },
      { site_tutorial_global_rounds_per_day: '0' },
      {
        site_tutorial_global_live_sessions_per_day: '17',
        site_tutorial_paused: 'on',
      },
    ];
    for (const stored of cases) {
      for (const env of [{}, { SITE_TUTORIAL_GLOBAL_ROUNDS_PER_DAY: '900' }]) {
        const { service, prisma } = setup(stored);
        service.env = env;
        const usage = new ClientSiteTutorialUsageService(prisma as never);
        usage.env = env;
        const v = await service.view(NOW);
        expect(v.rounds.value).toBe(await usage.globalRoundsLimit());
        expect(v.liveSessions.value).toBe(
          await usage.globalLiveSessionsLimit(),
        );
        expect(v.paused).toBe(await usage.paused());
      }
    }
  });
});

describe('просмотр', () => {
  it('умолчания, источник, расход за сутки, кэш 15 с', async () => {
    const { service, prisma } = setup();
    const v = await service.view(NOW);
    expect(v).toMatchObject({
      paused: false,
      day: '2026-10-07',
      cacheSeconds: 15,
      rounds: {
        value: DEFAULT_GLOBAL_ROUNDS_PER_DAY,
        stored: null,
        source: 'default',
        usedToday: 7,
      },
      liveSessions: {
        value: DEFAULT_GLOBAL_LIVE_SESSIONS_PER_DAY,
        source: 'default',
        usedToday: 2,
      },
    });
    const [sql, day] = prisma.$queryRaw.mock.calls[0] as unknown as [
      string[],
      string,
    ];
    expect(sql.join('?')).toContain('"client_site_tutorial_usage"');
    expect(day).toBe('2026-10-07');
  });

  it('задано оператором — источник admin, кто и когда', async () => {
    const { service } = setup({
      site_tutorial_paused: 'true',
      site_tutorial_global_rounds_per_day: '40',
    });
    service.env = { SITE_TUTORIAL_GLOBAL_ROUNDS_PER_DAY: '900' };
    const v = await service.view(NOW);
    expect(v.paused).toBe(true);
    expect(v.pausedUpdatedBy).toBe('op-0');
    expect(v.rounds).toMatchObject({
      value: 40,
      stored: 40,
      defaultValue: 900,
      source: 'admin',
      updatedAt: AT.toISOString(),
      updatedBy: 'op-0',
    });
  });

  it('env без админки — источник env', async () => {
    const { service } = setup();
    service.env = { SITE_TUTORIAL_GLOBAL_LIVE_SESSIONS_PER_DAY: '42' };
    const v = await service.view(NOW);
    expect(v.liveSessions).toMatchObject({ value: 42, source: 'env' });
  });

  it('расход не прочитался — null, а не ноль', async () => {
    const { service, prisma } = setup();
    prisma.$queryRaw.mockRejectedValueOnce(new Error('db'));
    const v = await service.view(NOW);
    expect(v.rounds.usedToday).toBeNull();
    expect(v.liveSessions.usedToday).toBeNull();
  });
});

describe('запись', () => {
  it('выключатель, потолки и «пусто = умолчание» — с автором', async () => {
    const { service, settings } = setup({
      site_tutorial_global_live_sessions_per_day: '17',
    });
    const v = await service.set(
      { paused: true, roundsPerDay: 250, liveSessionsPerDay: null },
      'op-1',
    );
    expect(settings.set.mock.calls).toEqual([
      ['site_tutorial_paused', 'true', 'op-1'],
      ['site_tutorial_global_rounds_per_day', '250', 'op-1'],
      ['site_tutorial_global_live_sessions_per_day', '', 'op-1'],
    ]);
    expect(v.paused).toBe(true);
    expect(v.rounds).toMatchObject({ value: 250, updatedBy: 'op-1' });
    expect(v.liveSessions).toMatchObject({
      value: DEFAULT_GLOBAL_LIVE_SESSIONS_PER_DAY,
      source: 'default',
    });
    await service.set({ paused: false }, 'op-2');
    expect(settings.set).toHaveBeenLastCalledWith(
      'site_tutorial_paused',
      'false',
      'op-2',
    );
  });

  it('не присланное не трогается', async () => {
    const { service, settings } = setup();
    await service.set({ roundsPerDay: 1 }, 'op');
    expect(settings.set).toHaveBeenCalledTimes(1);
  });

  it('негодный ввод — отказ целиком, ни одной записи', async () => {
    for (const bad of [
      { paused: true, roundsPerDay: 0 },
      { roundsPerDay: SITE_TUTORIAL_CAP_MAX + 1 },
      { liveSessionsPerDay: 2.5 },
      { roundsPerDay: -1 },
      { paused: 'yes' as unknown as boolean },
    ]) {
      const { service, settings } = setup();
      await expect(service.set(bad, 'op')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(settings.set).not.toHaveBeenCalled();
    }
    const { service } = setup();
    await expect(
      service.set({ roundsPerDay: SITE_TUTORIAL_CAP_MAX }, 'op'),
    ).resolves.toBeDefined();
  });
});
