import { UnauthorizedException } from '@nestjs/common';
import { withCronLock } from '../../../common/cron-job-lock';
import {
  AssistLearnRollupController,
  LEARN_ROLLUP_JOB,
} from './assist-learn-rollup.controller';

jest.mock('../../../common/cron-job-lock', () => ({
  withCronLock: jest.fn(),
}));

const lock = withCronLock as jest.MockedFunction<typeof withCronLock>;

const RESULT = {
  sites: 2,
  clustered: 5,
  reopened: 1,
  needsReview: 1,
  conflicts: 1,
  evalRuns: 1,
  evalDeferred: 0,
  forgetJobs: 3,
};

describe('GET /cron/assist-learn-rollup', () => {
  const env = { ...process.env };
  const now = new Date('2026-10-02T05:20:00Z');
  const run = jest.fn(async () => RESULT);
  const c = new AssistLearnRollupController({
    prisma: {} as never,
    now: () => now,
    run,
  } as never);

  beforeEach(() => {
    process.env.CRON_SECRET = 'sec';
    run.mockClear();
    lock.mockReset();
    lock.mockImplementation(async (_db, _key, _ttl, fn) => ({
      ran: true,
      result: await fn(),
    }));
  });
  afterAll(() => {
    process.env.CRON_SECRET = env.CRON_SECRET;
  });

  it('без секрета — 401, замок не берётся, разбора нет', async () => {
    await expect(c.run('Bearer nope')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(lock).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('под замком своего имени: разбор по ВСЕМ сайтам (без scope) с часами сервиса', async () => {
    const r = await c.run('Bearer sec');
    expect(lock).toHaveBeenCalledWith(
      expect.anything(),
      LEARN_ROLLUP_JOB,
      expect.any(Number),
      expect.any(Function),
    );
    expect(run).toHaveBeenCalledWith(now);
    expect(r).toEqual({ ran: true, ...RESULT });
  });

  it('замок занят — ran=false без разбора', async () => {
    lock.mockImplementation(async () => ({ ran: false }));
    expect(await c.run('Bearer sec')).toEqual({ ran: false });
    expect(run).not.toHaveBeenCalled();
  });
});
