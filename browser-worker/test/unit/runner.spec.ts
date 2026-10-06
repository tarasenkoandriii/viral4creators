/**
 * Цикл воркера без браузера: фейковый API и фейковые исполнители.
 * Аренда/heartbeat/повтор: «отменить» → `cancelled`, 409 → тихий обрыв без
 * `fail`, стена времени → `job_timeout`, код исполнителя → `fail(code)`,
 * чужой результат (хост вне замка) не уходит в `complete`, конкурентность,
 * остановка → `shutdown`.
 */
import type { Browser } from 'playwright-core';
import { ApiError, type WorkerApi } from '../../src/api-client';
import type { JobBrowser } from '../../src/browser/context';
import { JobError } from '../../src/errors';
import type { JobExecutor } from '../../src/jobs/types';
import { createLogger } from '../../src/logger';
import { Runner } from '../../src/runner';
import type { ClaimedJob } from '../../src/shared/browser-job-protocol';

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

function job(id: string, extra: Partial<ClaimedJob> = {}): ClaimedJob {
  return {
    id,
    kind: 'ui-snapshot',
    attempt: 1,
    leaseToken: 't'.repeat(43),
    leaseUntil: new Date().toISOString(),
    wallMs: 5_000,
    params: {
      url: 'https://shop.test/',
      allowedHosts: ['shop.test'],
      viewport: 'mobile',
      screenshot: false,
      mapElements: false,
    },
    needsCredentials: false,
    ...extra,
  };
}

const okResult = {
  finalUrl: 'https://shop.test/',
  snapshot: { url: 'https://shop.test/', title: 't', elements: [] },
  mapElements: [],
  screenshot: null,
  viewport: { width: 390, height: 844 },
  blockedRequests: 0,
};

class FakeApi implements WorkerApi {
  queue: ClaimedJob[] = [];
  completed: string[] = [];
  failed: Array<[string, string]> = [];
  heartbeats = 0;
  cancel = new Set<string>();
  lost = new Set<string>();
  maxSeen = 0;
  async claim(_k: unknown, max: number) {
    this.maxSeen = Math.max(this.maxSeen, max);
    return { enabled: true, jobs: this.queue.splice(0, max) };
  }
  async heartbeat(id: string) {
    this.heartbeats += 1;
    if (this.lost.has(id)) throw new ApiError(409, 'WORKER_LEASE_LOST');
    return { cancel: this.cancel.has(id) };
  }
  async complete(id: string) {
    this.completed.push(id);
  }
  async fail(id: string, _t: string, code: string) {
    this.failed.push([id, code]);
    return { retry: false };
  }
  async credentials(): Promise<{ sealed: string; attempt: number }> {
    throw new ApiError(403, 'WORKER_CREDENTIALS_DENIED');
  }
  async artifact() {
    return undefined;
  }
}

function make(
  api: FakeApi,
  exec: JobExecutor,
  concurrency = 2,
  extra: Partial<ConstructorParameters<typeof Runner>[0]> = {},
) {
  let active = 0;
  let peak = 0;
  const runner = new Runner({
    api,
    pool: {
      acquire: async () => {
        active += 1;
        peak = Math.max(peak, active);
        return {} as Browser;
      },
      release: () => {
        active -= 1;
      },
    },
    logger: createLogger('error', () => undefined),
    kinds: ['ui-snapshot', 'admin-crawl'],
    concurrency,
    pollMs: 10,
    idlePollMaxMs: 20,
    shutdownGraceMs: 200,
    heartbeatMs: 15,
    sealPrivateKey: null,
    egress: { denyCidrs: [], allowedPorts: [443], upstream: null },
    executors: { 'ui-snapshot': exec, 'admin-crawl': exec },
    openJobBrowser: async () =>
      ({
        close: async () => undefined,
        blocked: () => 0,
      }) as unknown as JobBrowser,
    ...extra,
  });
  return { runner, peak: () => peak };
}

describe('цикл воркера: аренда, heartbeat, повтор, остановка', () => {
  it('успех → complete; конкурентность не выше заданной', async () => {
    const api = new FakeApi();
    api.queue = [job('a'), job('b'), job('c'), job('d')];
    const { runner, peak } = make(api, async () => {
      await tick(40);
      return okResult;
    });
    runner.start();
    for (let i = 0; i < 100 && api.completed.length < 4; i++) await tick();
    await runner.shutdown();
    expect(api.completed.sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(peak()).toBeLessThanOrEqual(2);
    expect(api.maxSeen).toBeLessThanOrEqual(2);
    expect(api.heartbeats).toBeGreaterThan(0);
  });

  it('heartbeat «отменить» → fail(cancelled); 409 «аренда потеряна» → без fail и без complete', async () => {
    const api = new FakeApi();
    api.queue = [job('x'), job('y')];
    api.cancel.add('x');
    api.lost.add('y');
    const { runner } = make(
      api,
      (ctx) =>
        new Promise((_r, reject) =>
          ctx.signal.addEventListener('abort', () =>
            reject(
              new Error('Target page, context or browser has been closed'),
            ),
          ),
        ),
    );
    runner.start();
    for (let i = 0; i < 100 && api.failed.length < 1; i++) await tick();
    await tick(100);
    await runner.shutdown();
    expect(api.failed).toEqual([['x', 'cancelled']]);
    expect(api.completed).toEqual([]);
  });

  it('стена времени → job_timeout; код исполнителя → fail(code); непонятная ошибка → internal', async () => {
    const api = new FakeApi();
    api.queue = [job('slow', { wallMs: 50 }), job('egress'), job('boom')];
    const { runner } = make(
      api,
      (ctx) => {
        if (ctx.job.id === 'egress')
          return Promise.reject(new JobError('egress_blocked'));
        if (ctx.job.id === 'boom')
          return Promise.reject(new Error('something odd'));
        return new Promise((_r, reject) =>
          ctx.signal.addEventListener('abort', () =>
            reject(new Error('closed')),
          ),
        );
      },
      3,
    );
    runner.start();
    for (let i = 0; i < 100 && api.failed.length < 3; i++) await tick();
    await runner.shutdown();
    expect(Object.fromEntries(api.failed)).toEqual({
      slow: 'job_timeout',
      egress: 'egress_blocked',
      boom: 'internal',
    });
  });

  it('результат с адресом вне замка задания не уходит в complete', async () => {
    const api = new FakeApi();
    api.queue = [job('leak')];
    const { runner } = make(api, async () => ({
      ...okResult,
      finalUrl: 'https://evil.test/',
    }));
    runner.start();
    for (let i = 0; i < 100 && api.failed.length < 1; i++) await tick();
    await runner.shutdown();
    expect(api.completed).toEqual([]);
    expect(api.failed[0][0]).toBe('leak');
  });

  it('учётка без ключа конверта — credentials_unavailable, запроса учётки нет', async () => {
    const api = new FakeApi();
    const spy = jest.spyOn(api, 'credentials');
    api.queue = [job('crawl', { kind: 'admin-crawl', needsCredentials: true })];
    const { runner } = make(api, async (ctx) => {
      await ctx.credentials();
      return okResult;
    });
    runner.start();
    for (let i = 0; i < 100 && api.failed.length < 1; i++) await tick();
    await runner.shutdown();
    expect(api.failed).toEqual([['crawl', 'credentials_unavailable']]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('остановка: идущее задание после срока — shutdown (повторяемый код)', async () => {
    const api = new FakeApi();
    api.queue = [job('long', { wallMs: 60_000 })];
    const { runner } = make(
      api,
      (ctx) =>
        new Promise((_r, reject) =>
          ctx.signal.addEventListener('abort', () =>
            reject(new Error('closed')),
          ),
        ),
    );
    runner.start();
    for (let i = 0; i < 50 && runner.active < 1; i++) await tick();
    await runner.shutdown();
    expect(api.failed).toEqual([['long', 'shutdown']]);
  });
});
