/**
 * Ротация браузера (Э-С Ш3): после N заданий или M минут Chromium
 * перезапускается, но только когда на старом нет идущих заданий; упавший
 * браузер поднимается заново; песочница и «чёрная дыра» прокси — в флагах
 * запуска.
 */
import { BrowserPool, HARDENING_ARGS } from '../../src/browser/pool';
import { createLogger } from '../../src/logger';

type Listener = () => void;
const launched: Array<{
  closed: boolean;
  connected: boolean;
  emit: () => void;
  opts: unknown;
}> = [];

jest.mock('playwright-core', () => ({
  chromium: {
    launch: jest.fn(async (opts: unknown) => {
      const handlers: Listener[] = [];
      const b = {
        closed: false,
        connected: true,
        opts,
        emit: () => handlers.forEach((h) => h()),
        isConnected() {
          return this.connected && !this.closed;
        },
        on(_e: string, h: Listener) {
          handlers.push(h);
        },
        version: () => '141.0',
        async close() {
          this.closed = true;
        },
      };
      launched.push(b);
      return b;
    }),
  },
}));

describe('пул браузера воркера', () => {
  beforeEach(() => {
    launched.length = 0;
  });
  const logger = createLogger('error', () => undefined);

  it('песочница и прокси-«чёрная дыра» в флагах запуска', async () => {
    const pool = new BrowserPool({
      executablePath: null,
      sandbox: true,
      rotateJobs: 10,
      rotateMs: 60_000,
      logger,
    });
    await pool.acquire();
    const opts = launched[0].opts as {
      chromiumSandbox: boolean;
      args: string[];
    };
    expect(opts.chromiumSandbox).toBe(true);
    expect(opts.args).toEqual(HARDENING_ARGS);
    expect(opts.args).toContain('--proxy-bypass-list=<-loopback>');
  });

  it('Ш3-хвост (18): DNS-prefetch выключен, локальный резолв закрыт (кроме прокси на 127.0.0.1)', async () => {
    const pool = new BrowserPool({
      executablePath: null,
      sandbox: true,
      rotateJobs: 10,
      rotateMs: 60_000,
      logger,
    });
    await pool.acquire();
    const { args } = launched[0].opts as { args: string[] };
    expect(args).toContain('--dns-prefetch-disable');
    expect(args).toContain(
      '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1',
    );
  });

  it('аудит Ш3: секреты воркера в окружение Chromium не попадают', async () => {
    const saved = { ...process.env };
    process.env.SITES_WORKER_HMAC_SECRET = 'h'.repeat(40);
    process.env.BROWSER_WORKER_SEAL_PRIVATE_KEY = 'k'.repeat(43);
    process.env.TZ = 'UTC';
    try {
      const pool = new BrowserPool({
        executablePath: null,
        sandbox: true,
        rotateJobs: 10,
        rotateMs: 60_000,
        logger,
      });
      await pool.acquire();
      const env = (launched[0].opts as { env?: Record<string, string> }).env;
      expect(env).toBeDefined();
      expect(env!.TZ).toBe('UTC');
      expect(env!.PATH).toBe(process.env.PATH);
      expect(JSON.stringify(env)).not.toMatch(/h{40}|k{43}/);
      expect(Object.keys(env!).some((k) => /SECRET|KEY|TOKEN/.test(k))).toBe(
        false,
      );
    } finally {
      process.env = saved;
    }
  });

  it('ротация после N заданий — только без идущих заданий', async () => {
    const pool = new BrowserPool({
      executablePath: null,
      sandbox: false,
      rotateJobs: 2,
      rotateMs: 60_000,
      logger,
    });
    await pool.acquire();
    await pool.acquire();
    // Пора, но два задания ещё идут — тот же браузер.
    await pool.acquire();
    expect(launched).toHaveLength(1);
    pool.release();
    pool.release();
    pool.release();
    await pool.acquire();
    expect(launched).toHaveLength(2);
    expect(launched[0].closed).toBe(true);
  });

  it('ротация по времени; упавший браузер поднимается заново', async () => {
    let now = 0;
    const pool = new BrowserPool({
      executablePath: null,
      sandbox: false,
      rotateJobs: 100,
      rotateMs: 1_000,
      logger,
      now: () => now,
    });
    await pool.acquire();
    pool.release();
    now = 5_000;
    await pool.acquire();
    pool.release();
    expect(launched).toHaveLength(2);
    launched[1].connected = false;
    launched[1].emit();
    await pool.acquire();
    expect(launched).toHaveLength(3);
  });

  it('Ш3-хвост (16): непрерывная нагрузка — дренаж, затем ротация без обрыва идущих', async () => {
    const pool = new BrowserPool({
      executablePath: null,
      sandbox: false,
      rotateJobs: 2,
      rotateMs: 60 * 60_000,
      logger,
    });
    const a = await pool.acquire();
    const b = await pool.acquire();
    expect(pool.holdClaims()).toBe(true); // пора, а на браузере два задания
    expect(pool.draining).toBe(true);
    pool.release(a);
    // Без дренажа здесь цикл взял бы новое задание и браузер не опустел бы.
    expect(pool.holdClaims()).toBe(true);
    pool.release(b);
    expect(pool.holdClaims()).toBe(false); // опустел — можно брать
    const c = await pool.acquire();
    expect(launched).toHaveLength(2);
    expect(launched[0].closed).toBe(true);
    expect(c).toBe(launched[1]);
    expect(pool.draining).toBe(false);
    expect(pool.rotations).toBe(1);
  });

  it('дренаж с потолком: зависшее задание — старый браузер «в отставке», закрыт после него', async () => {
    let now = 0;
    const pool = new BrowserPool({
      executablePath: null,
      sandbox: false,
      rotateJobs: 1,
      rotateMs: 60 * 60_000,
      drainMaxMs: 1_000,
      logger,
      now: () => now,
    });
    const stuck = await pool.acquire();
    expect(pool.holdClaims()).toBe(true);
    now = 999;
    expect(pool.holdClaims()).toBe(true);
    now = 1_000;
    expect(pool.holdClaims()).toBe(false); // потолок вышел — снова берём
    const fresh = await pool.acquire();
    expect(launched).toHaveLength(2);
    expect(fresh).toBe(launched[1]);
    // Идущее задание не оборвано: старый браузер жив, пока оно не вернётся.
    expect(launched[0].closed).toBe(false);
    expect(pool.forcedRotations).toBe(1);
    pool.release(stuck);
    expect(launched[0].closed).toBe(true);
    // Свежий браузер не тронут возвратом старого.
    expect(launched[1].closed).toBe(false);
    pool.release(fresh);
    await pool.close();
    expect(launched[1].closed).toBe(true);
  });

  it('не пора ротировать — claim не держится; закрытый пул — тоже', async () => {
    const pool = new BrowserPool({
      executablePath: null,
      sandbox: false,
      rotateJobs: 10,
      rotateMs: 60 * 60_000,
      logger,
    });
    expect(pool.holdClaims()).toBe(false); // браузера ещё нет
    await pool.acquire();
    expect(pool.holdClaims()).toBe(false);
    await pool.close();
    expect(pool.holdClaims()).toBe(false);
  });
});
