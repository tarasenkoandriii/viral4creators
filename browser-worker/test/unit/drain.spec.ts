/**
 * Ш3-хвост (16): ротация Chromium при НЕПРЕРЫВНОЙ нагрузке. Цикл воркера и
 * настоящий пул (Chromium — заглушка): очередь никогда не пустеет, задания
 * идут внахлёст, поэтому «идущих 0» без дренажа не бывает никогда. С
 * дренажем браузер ротируется, и ни одно задание не теряет браузер посреди
 * работы.
 */
import type { Browser } from 'playwright-core';
import type { WorkerApi } from '../../src/api-client';
import { BrowserPool } from '../../src/browser/pool';
import type { JobBrowser } from '../../src/browser/context';
import { createLogger } from '../../src/logger';
import { Runner } from '../../src/runner';
import type { ClaimedJob } from '../../src/shared/browser-job-protocol';

interface FakeBrowser {
  id: number;
  running: number;
  closed: boolean;
  closedWhileRunning: boolean;
}
const launched: FakeBrowser[] = [];

jest.mock('playwright-core', () => ({
  chromium: {
    launch: jest.fn(async () => {
      const b = {
        id: launched.length + 1,
        running: 0,
        closed: false,
        closedWhileRunning: false,
        isConnected() {
          return !this.closed;
        },
        on() {
          return undefined;
        },
        version: () => '153.0',
        async close() {
          if (this.running > 0) this.closedWhileRunning = true;
          this.closed = true;
        },
      };
      launched.push(b);
      return b;
    }),
  },
}));

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

let seq = 0;
function job(): ClaimedJob {
  seq += 1;
  return {
    id: `j${seq}`,
    kind: 'ui-snapshot',
    attempt: 1,
    leaseToken: 't'.repeat(43),
    leaseUntil: new Date().toISOString(),
    wallMs: 10_000,
    params: {
      url: 'https://shop.test/',
      allowedHosts: ['shop.test'],
      viewport: 'mobile',
      screenshot: false,
      mapElements: false,
    },
    needsCredentials: false,
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

/** Очередь, которая никогда не пустеет. */
class EndlessApi implements WorkerApi {
  completed = 0;
  failed: string[] = [];
  async claim(_k: unknown, max: number) {
    return { enabled: true, jobs: Array.from({ length: max }, job) };
  }
  async heartbeat() {
    return { cancel: false };
  }
  async complete() {
    this.completed += 1;
  }
  async fail(_id: string, _t: string, code: string) {
    this.failed.push(code);
    return { retry: false };
  }
  async credentials(): Promise<{ sealed: string; attempt: number }> {
    throw new Error('нет');
  }
  async artifact() {
    return undefined;
  }
}

describe('дренаж перед ротацией под непрерывной нагрузкой', () => {
  beforeEach(() => {
    launched.length = 0;
  });

  it('браузер ротируется, ни одно задание не потеряло браузер, фейлов нет', async () => {
    const api = new EndlessApi();
    const logger = createLogger('error', () => undefined);
    const pool = new BrowserPool({
      executablePath: null,
      sandbox: false,
      rotateJobs: 4,
      rotateMs: 60 * 60_000,
      drainMaxMs: 60_000,
      logger,
    });
    let n = 0;
    const runner = new Runner({
      api,
      pool,
      logger,
      kinds: ['ui-snapshot'],
      concurrency: 2,
      pollMs: 5,
      idlePollMaxMs: 10,
      shutdownGraceMs: 500,
      heartbeatMs: 1_000,
      sealPrivateKey: null,
      egress: { denyCidrs: [], allowedPorts: [443], upstream: null },
      // Внахлёст: длительности 30/55 мс — оба места почти никогда не
      // освобождаются одновременно.
      executors: {
        'ui-snapshot': async () => {
          n += 1;
          await tick(n % 2 ? 30 : 55);
          return okResult;
        },
      },
      openJobBrowser: async (b: Browser) => {
        const fb = b as unknown as FakeBrowser;
        fb.running += 1;
        return {
          close: async () => {
            fb.running -= 1;
          },
          blocked: () => 0,
          traffic: () => ({
            bytesIn: 0,
            bytesOut: 0,
            connections: 0,
            refused: 0,
            cutResponses: 0,
            cutJob: false,
          }),
        } as unknown as JobBrowser;
      },
    });
    runner.start();
    for (let i = 0; i < 300 && api.completed < 20; i++) await tick();
    await runner.shutdown();
    await pool.close();
    expect(api.completed).toBeGreaterThanOrEqual(20);
    expect(api.failed).toEqual([]);
    // 20+ заданий по 4 на браузер — ротаций несколько, а не ноль.
    expect(launched.length).toBeGreaterThanOrEqual(4);
    expect(launched.some((b) => b.closedWhileRunning)).toBe(false);
    expect(pool.forcedRotations).toBe(0);
  });
});
