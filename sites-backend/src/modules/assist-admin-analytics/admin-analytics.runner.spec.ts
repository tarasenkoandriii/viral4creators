/**
 * Аудит захода 10: оркестратор аналитики «Админки» — разметка до свёртки,
 * троттлинг 10 мин, уборка раз в сутки, сбой части не роняет остальные.
 */
import { tryAcquireCronLock } from '../../common/cron-job-lock';
import {
  ADMIN_ANALYTICS_DAILY_JOB,
  ADMIN_ANALYTICS_JOB,
  AdminAnalyticsRunner,
} from './admin-analytics.runner';

jest.mock('../../common/cron-job-lock', () => ({
  tryAcquireCronLock: jest.fn(),
}));
const lock = tryAcquireCronLock as jest.MockedFunction<
  typeof tryAcquireCronLock
>;

function runner(order: string[]) {
  const step =
    (name: string, v: unknown = {}) =>
    async () => {
      order.push(name);
      return v;
    };
  return new AdminAnalyticsRunner(
    {} as never,
    {
      process: jest.fn(step('exports')),
      purgeJournal: jest.fn(step('purge-exports', 0)),
    } as never,
    { tick: jest.fn(step('alerts')) } as never,
    {
      tick: jest.fn(step('rollup')),
      purge: jest.fn(step('purge-stats', 0)),
    } as never,
    {
      tick: jest.fn(async () => {
        order.push('labels');
        throw new Error('boom');
      }),
    } as never,
    {
      tick: jest.fn(step('weekly')),
      purge: jest.fn(step('purge-insights', 0)),
    } as never,
  );
}

describe('AdminAnalyticsRunner', () => {
  beforeEach(() => lock.mockReset());

  it('разметка — до свёртки; сбой разметки не мешает свёртке и неделе; уборка — по суточному замку', async () => {
    lock.mockResolvedValue('holder');
    const order: string[] = [];
    const r = await runner(order).run(new Date(), Date.now() + 20_000);
    expect(order).toEqual([
      'exports',
      'alerts',
      'labels',
      'rollup',
      'weekly',
      'purge-stats',
      'purge-insights',
      'purge-exports',
    ]);
    expect(r.labels).toBeNull();
    expect(lock.mock.calls.map((c) => c[1])).toEqual([
      ADMIN_ANALYTICS_JOB,
      ADMIN_ANALYTICS_DAILY_JOB,
    ]);
    expect(lock.mock.calls[0][2]).toBe(10 * 60 * 1000);
    expect(lock.mock.calls[1][2]).toBe(24 * 60 * 60 * 1000);
  });

  it('троттлинг: замок 10 мин занят — только выгрузки', async () => {
    lock.mockResolvedValue(null);
    const order: string[] = [];
    const r = await runner(order).run(new Date(), Date.now() + 20_000);
    expect(r.throttled).toBe(true);
    expect(order).toEqual(['exports']);
  });

  it('суточный замок занят — без уборки', async () => {
    lock.mockResolvedValueOnce('h').mockResolvedValueOnce(null);
    const order: string[] = [];
    await runner(order).run(new Date(), Date.now() + 20_000);
    expect(order.filter((x) => x.startsWith('purge'))).toEqual([]);
  });
});
