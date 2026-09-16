import { createLogger } from '../src/logger';
import {
  SessionLimitError,
  SessionManager,
  SessionNotFoundError,
  SessionNotReadyError,
} from '../src/session-manager';
import {
  SessionAlreadyClosedError,
  type RelayBrowser,
  type RelayCdpSession,
  type RelayFrame,
  type RelayPage,
} from '../src/session';

function makeFakeBrowser(): RelayBrowser {
  const frame: RelayFrame = { url: () => 'https://example.com/' };
  const cdp: RelayCdpSession = {
    send: jest.fn().mockResolvedValue({ cookies: [] }),
    on: jest.fn(),
  };
  const page: RelayPage = {
    goto: jest.fn().mockResolvedValue(undefined),
    url: () => 'https://example.com/',
    target: () => ({ createCDPSession: () => Promise.resolve(cdp) }),
    on: jest.fn(),
    mainFrame: () => frame,
    close: jest.fn().mockResolvedValue(undefined),
  };
  return {
    newPage: jest.fn().mockResolvedValue(page),
    close: jest.fn().mockResolvedValue(undefined),
  };
}

const logger = createLogger('error');

function makeManager(
  overrides: Partial<{
    maxConcurrentSessions: number;
    wallTimeoutMs: number;
    idleTimeoutMs: number;
    resultCacheMs: number;
  }> = {},
): SessionManager {
  return new SessionManager({
    maxConcurrentSessions: overrides.maxConcurrentSessions ?? 2,
    wallTimeoutMs: overrides.wallTimeoutMs ?? 180_000,
    idleTimeoutMs: overrides.idleTimeoutMs ?? 60_000,
    resultCacheMs: overrides.resultCacheMs ?? 60_000,
    logger,
    launchBrowser: async () => makeFakeBrowser(),
  });
}

describe('SessionManager', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('creates sessions up to the concurrency limit, then rejects', async () => {
    const manager = makeManager({ maxConcurrentSessions: 1 });
    await manager.createSession(
      'https://example.com/login',
      'https://example.com',
    );
    await expect(
      manager.createSession('https://example.com/login', 'https://example.com'),
    ).rejects.toBeInstanceOf(SessionLimitError);
  });

  it('throws for an unknown session id', () => {
    const manager = makeManager();
    expect(() => manager.getSession('does-not-exist')).toThrow(
      SessionNotFoundError,
    );
  });

  it('rejects finalize while the session is still in "created" state', async () => {
    const manager = makeManager();
    const session = await manager.createSession(
      'https://example.com/login',
      'https://example.com',
    );
    await expect(manager.finalizeSession(session.id)).rejects.toBeInstanceOf(
      SessionNotReadyError,
    );
  });

  it('expires a session after the wall timeout', async () => {
    const manager = makeManager({ wallTimeoutMs: 1000 });
    const session = await manager.createSession(
      'https://example.com/login',
      'https://example.com',
    );
    jest.advanceTimersByTime(1001);
    await flushMicrotasks();
    expect(session.state).toBe('closed');
  });

  it('expires a streaming session after the idle timeout with no activity', async () => {
    const manager = makeManager({
      idleTimeoutMs: 1000,
      wallTimeoutMs: 180_000,
    });
    const session = await manager.createSession(
      'https://example.com/login',
      'https://example.com',
    );
    session.state = 'streaming';
    jest.advanceTimersByTime(1001);
    await flushMicrotasks();
    expect(session.state).toBe('closed');
  });

  it('does not expire a streaming session that had recent activity', async () => {
    const manager = makeManager({
      idleTimeoutMs: 1000,
      wallTimeoutMs: 180_000,
    });
    const session = await manager.createSession(
      'https://example.com/login',
      'https://example.com',
    );
    session.state = 'streaming';
    jest.advanceTimersByTime(600);
    session.markActivity();
    jest.advanceTimersByTime(600);
    await flushMicrotasks();
    expect(session.state).toBe('streaming');
  });

  it('finalize returns the cached result on a repeat call within the cache window', async () => {
    const manager = makeManager({ resultCacheMs: 5000 });
    const session = await manager.createSession(
      'https://example.com/login',
      'https://example.com',
    );
    session.state = 'streaming';
    const first = await manager.finalizeSession(session.id);
    const second = await manager.finalizeSession(session.id);
    expect(second).toEqual(first);
  });

  it('evicts the session once the result cache window elapses', async () => {
    const manager = makeManager({ resultCacheMs: 1000 });
    const session = await manager.createSession(
      'https://example.com/login',
      'https://example.com',
    );
    session.state = 'streaming';
    await manager.finalizeSession(session.id);
    jest.advanceTimersByTime(1001);
    expect(() => manager.getSession(session.id)).toThrow(SessionNotFoundError);
  });

  it('cancelSession is idempotent for an unknown session id', async () => {
    const manager = makeManager();
    await expect(
      manager.cancelSession('does-not-exist'),
    ).resolves.toBeUndefined();
  });

  it(
    'still evicts a session from the map when finalize() throws ' +
      '(Bug C — leak fix: scheduleEviction ran in try/finally before ' +
      'clearActiveTimers already disarmed the wall/idle timers)',
    async () => {
      const manager = makeManager({ resultCacheMs: 1000 });
      const session = await manager.createSession(
        'https://example.com/login',
        'https://example.com',
      );
      session.state = 'streaming';
      // Форсированно закрываем сессию В ОБХОД менеджера, не через
      // cancelSession()/expire() — так manager ещё не знает, что сессия
      // закрыта: его wall/idle-таймеры для неё всё ещё взведены, и
      // scheduleEviction() для неё ещё ни разу не вызывался. Это и есть
      // точный сценарий бага: finalizeSession() сейчас снимет активные
      // таймеры (clearActiveTimers), а session.finalize() тут же бросит
      // SessionAlreadyClosedError.
      await session.close('cancelled');

      await expect(manager.finalizeSession(session.id)).rejects.toBeInstanceOf(
        SessionAlreadyClosedError,
      );

      // Без finally-фикса ни один таймер для этой сессии больше не взведён
      // (wall/idle сняты, scheduleEviction не вызван) — она осталась бы в
      // this.sessions навсегда. С фиксом finally всё равно поставил
      // eviction-таймер.
      jest.advanceTimersByTime(1001);
      expect(() => manager.getSession(session.id)).toThrow(
        SessionNotFoundError,
      );
    },
  );

  it('activeCount only counts created/streaming sessions', async () => {
    const manager = makeManager({ maxConcurrentSessions: 5 });
    const a = await manager.createSession(
      'https://example.com/login',
      'https://example.com',
    );
    await manager.createSession(
      'https://example.com/login',
      'https://example.com',
    );
    expect(manager.activeCount).toBe(2);
    a.state = 'streaming';
    await manager.finalizeSession(a.id);
    expect(manager.activeCount).toBe(1);
  });
});

/** Даёт микрозадачам (await внутри close()/finalize()) отработать после
 * jest.advanceTimersByTime — таймеры срабатывают синхронно, но код
 * внутри их колбэков — асинхронный (await page.close() и т.п.). */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
