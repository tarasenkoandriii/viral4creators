/**
 * Цикл воркера без браузера: фейковый API и фейковые исполнители.
 * Аренда/heartbeat/повтор: «отменить» → `cancelled`, 409 → тихий обрыв без
 * `fail`, heartbeat не проходит дольше `leaseMs` (сеть, 5xx, зависание) —
 * тот же тихий обрыв, короткий сбой — нет; стена времени → `job_timeout`, код исполнителя → `fail(code)`,
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
  /** Сеть до sites-backend лежит: каждый heartbeat — ошибка не-HTTP. */
  down = new Set<string>();
  /** 503 на первые N heartbeat задания, потом — норма. */
  flaky = new Map<string, number>();
  /** heartbeat повисает навсегда. */
  hang = new Set<string>();
  maxSeen = 0;
  async claim(_k: unknown, max: number) {
    this.maxSeen = Math.max(this.maxSeen, max);
    return { enabled: true, jobs: this.queue.splice(0, max) };
  }
  async heartbeat(id: string) {
    this.heartbeats += 1;
    if (this.lost.has(id)) throw new ApiError(409, 'WORKER_LEASE_LOST');
    if (this.down.has(id)) throw new TypeError('fetch failed');
    if (this.hang.has(id)) return new Promise<never>(() => undefined);
    const left = this.flaky.get(id) ?? 0;
    if (left > 0) {
      this.flaky.set(id, left - 1);
      throw new ApiError(503, 'UNAVAILABLE');
    }
    return { cancel: this.cancel.has(id) };
  }
  /** complete отвечает этой ошибкой (сервер не принял результат). */
  completeError: ApiError | null = null;
  async complete(id: string) {
    if (this.completeError) throw this.completeError;
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
        traffic: () => ({
          bytesIn: 0,
          bytesOut: 0,
          connections: 0,
          refused: 0,
          cutResponses: 0,
          cutJob: false,
        }),
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

  it('heartbeat не проходит дольше leaseMs (сеть, зависание) → lease_lost без fail; короткий сбой — не обрыв', async () => {
    const api = new FakeApi();
    api.queue = [job('net'), job('hung'), job('blip')];
    api.down.add('net');
    api.hang.add('hung');
    api.flaky.set('blip', 2); // ~30 мс сбоя при аренде 150 мс
    const aborted: string[] = [];
    const { runner } = make(
      api,
      (ctx) =>
        new Promise((resolve, reject) => {
          const t = setTimeout(
            () => resolve(okResult),
            ctx.job.id === 'blip' ? 250 : 5_000,
          );
          ctx.signal.addEventListener('abort', () => {
            clearTimeout(t);
            aborted.push(ctx.job.id);
            reject(
              new Error('Target page, context or browser has been closed'),
            );
          });
        }),
      3,
      { leaseMs: 150 },
    );
    runner.start();
    for (
      let i = 0;
      i < 200 && (aborted.length < 2 || api.completed.length < 1);
      i++
    )
      await tick();
    await tick(50);
    await runner.shutdown();
    expect(aborted.sort()).toEqual(['hung', 'net']);
    expect(api.failed).toEqual([]);
    expect(api.completed).toEqual(['blip']);
  });

  it('аренда отсчитывается от последнего удачного heartbeat, а не от взятия', async () => {
    let t = 0;
    const api = new FakeApi();
    api.queue = [job('long')];
    const { runner } = make(
      api,
      (ctx) =>
        new Promise((resolve, reject) => {
          // Логические часы: каждый тик heartbeat — +40 «мс» при аренде 100.
          const timer = setTimeout(() => resolve(okResult), 200);
          ctx.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('closed'));
          });
        }),
      1,
      { leaseMs: 100, now: () => (t += 40) },
    );
    runner.start();
    for (let i = 0; i < 100 && api.completed.length < 1; i++) await tick();
    await runner.shutdown();
    // Каждый удачный heartbeat сдвигает отсчёт — за 200 мс работы
    // (≈ 13 тиков × 40 «мс» ≫ 100) обрыва нет.
    expect(api.completed).toEqual(['long']);
    expect(api.failed).toEqual([]);
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

  it('сервер не принял результат (400 WORKER_BAD_RESULT) — too_large, без повтора; 5xx при сдаче — internal', async () => {
    const api = new FakeApi();
    api.completeError = new ApiError(400, 'WORKER_BAD_RESULT');
    api.queue = [job('big')];
    const { runner } = make(api, async () => okResult);
    runner.start();
    for (let i = 0; i < 100 && api.failed.length < 1; i++) await tick();
    api.completeError = new ApiError(503, 'UNAVAILABLE');
    api.queue = [job('down')];
    for (let i = 0; i < 100 && api.failed.length < 2; i++) await tick();
    await runner.shutdown();
    expect(Object.fromEntries(api.failed)).toEqual({
      big: 'too_large',
      down: 'internal',
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

  it('Ш3-хвост (9): потолок трафика задания → fail(traffic_limit), счётчики в журнале', async () => {
    const api = new FakeApi();
    api.queue = [job('fat')];
    const lines: string[] = [];
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
      1,
      {
        logger: createLogger('info', (l) => lines.push(l)),
        openJobBrowser: async (_b, _j, onTrafficLimit) => {
          setTimeout(onTrafficLimit, 30);
          return {
            close: async () => undefined,
            blocked: () => 0,
            traffic: () => ({
              bytesIn: 9_000_000,
              bytesOut: 1_000,
              connections: 3,
              refused: 0,
              cutResponses: 0,
              cutJob: true,
            }),
          } as unknown as JobBrowser;
        },
      },
    );
    runner.start();
    for (let i = 0; i < 100 && api.failed.length < 1; i++) await tick();
    await runner.shutdown();
    expect(api.failed).toEqual([['fat', 'traffic_limit']]);
    const rec = lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((r) => r.msg === 'потолок трафика');
    expect(rec).toMatchObject({ jobId: 'fat', bytes: 9_000_000, cut: 'job' });
  });

  it('дренаж: пул держит claim — свободные места не заполняются', async () => {
    const api = new FakeApi();
    api.queue = [job('a'), job('b'), job('c')];
    let hold = true;
    const spy = jest.spyOn(api, 'claim');
    const { runner } = make(api, async () => okResult, 2, {
      pool: {
        acquire: async () => ({}) as Browser,
        release: () => undefined,
        holdClaims: () => hold,
      },
    });
    runner.start();
    try {
      await tick(80);
      expect(spy).not.toHaveBeenCalled();
      hold = false;
      for (let i = 0; i < 100 && api.completed.length < 3; i++) await tick();
    } finally {
      await runner.shutdown();
    }
    expect(api.completed.sort()).toEqual(['a', 'b', 'c']);
  });
});
