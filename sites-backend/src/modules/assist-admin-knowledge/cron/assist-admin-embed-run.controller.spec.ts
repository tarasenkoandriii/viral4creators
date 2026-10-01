import { UnauthorizedException } from '@nestjs/common';
import { withCronLock } from '../../../common/cron-job-lock';
import {
  ADMIN_EMBED_RUN_JOB,
  AssistAdminEmbedRunController,
} from './assist-admin-embed-run.controller';

jest.mock('../../../common/cron-job-lock', () => ({
  withCronLock: jest.fn(),
}));

const lock = withCronLock as jest.MockedFunction<typeof withCronLock>;

describe('GET /cron/assist-admin-embed-run', () => {
  const env = { ...process.env };
  beforeEach(() => {
    process.env.CRON_SECRET = 'sec';
    lock.mockReset();
    lock.mockImplementation(async (_db, _key, _ttl, fn) => ({
      ran: true,
      result: await fn(),
    }));
  });
  afterAll(() => {
    process.env.CRON_SECRET = env.CRON_SECRET;
  });

  it('свой замок, файлы «Админки» и индексация «Админки»; сбой файлов не мешает', async () => {
    const tick = jest.fn(async () => ({
      sitesTouched: 1,
      versionsCreated: 1,
      budgetExhausted: false,
    }));
    const c = new AssistAdminEmbedRunController(
      {} as never,
      {
        processPendingFiles: jest.fn(async () => {
          throw new Error('x');
        }),
      } as never,
      { tick } as never,
    );
    await expect(c.run('Bearer bad')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    const r = await c.run('Bearer sec');
    expect(lock.mock.calls[0][1]).toBe(ADMIN_EMBED_RUN_JOB);
    expect(tick).toHaveBeenCalled();
    expect(r).toMatchObject({
      ran: true,
      filesError: 'Error',
      index: { versionsCreated: 1 },
    });
  });
});
