import {
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { withCronLock } from '../../../common/cron-job-lock';
import {
  AssistEmbedRunController,
  EMBED_RUN_JOB,
} from './assist-embed-run.controller';

jest.mock('../../../common/cron-job-lock', () => ({
  withCronLock: jest.fn(),
}));

const lock = withCronLock as jest.MockedFunction<typeof withCronLock>;

function make(files: () => Promise<{ processed: number }>) {
  const tick = jest.fn(async () => ({
    sitesTouched: 1,
    versionsCreated: 1,
    versionsHeld: 0,
    chunksEmbedded: 3,
    chunksReused: 2,
    budgetExhausted: false,
  }));
  const c = new AssistEmbedRunController(
    {} as never,
    { processPendingFiles: jest.fn(files) } as never,
    { tick } as never,
  );
  return { c, tick };
}

describe('GET /cron/assist-embed-run', () => {
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

  it('без секрета — отказ, замок не берётся', async () => {
    const { c } = make(async () => ({ processed: 0 }));
    await expect(c.run('Bearer nope')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    delete process.env.CRON_SECRET;
    process.env.ALLOW_DEV_AUTH = 'false';
    await expect(c.run(undefined)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(lock).not.toHaveBeenCalled();
  });

  it('под замком: сначала файлы, потом индексация', async () => {
    const order: string[] = [];
    const { c, tick } = make(async () => {
      order.push('files');
      return { processed: 2 };
    });
    tick.mockImplementation(async () => {
      order.push('index');
      return {
        sitesTouched: 0,
        versionsCreated: 0,
        versionsHeld: 0,
        chunksEmbedded: 0,
        chunksReused: 0,
        budgetExhausted: false,
      };
    });
    const r = await c.run('Bearer sec');
    expect(order).toEqual(['files', 'index']);
    expect(r).toMatchObject({ ran: true, filesProcessed: 2, filesError: null });
    expect(lock.mock.calls[0][1]).toBe(EMBED_RUN_JOB);
  });

  it('сбой разбора файлов не останавливает индексацию обхода', async () => {
    const { c, tick } = make(async () => {
      throw new Error('blob down');
    });
    const r = await c.run('Bearer sec');
    expect(tick).toHaveBeenCalled();
    expect(r).toMatchObject({
      ran: true,
      filesProcessed: 0,
      filesError: 'Error',
    });
    expect(r.index?.chunksEmbedded).toBe(3);
  });

  it('замок занят — ничего не делает', async () => {
    lock.mockResolvedValueOnce({ ran: false });
    const { c, tick } = make(async () => ({ processed: 0 }));
    expect(await c.run('Bearer sec')).toEqual({
      ran: false,
      filesProcessed: 0,
      filesError: null,
      index: null,
    });
    expect(tick).not.toHaveBeenCalled();
  });
});
