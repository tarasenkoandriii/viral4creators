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
    navTimeoutMs: 20_000,
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

  it(
    'закрывает уже запущенный браузер, если Session.create() упал ' +
      '(этап 108 — иначе процесс Chromium утекал навсегда на каждой ' +
      'неудачной навигации: в map он не попал, таймеров нет, ссылок нет)',
    async () => {
      const browser = makeFakeBrowser();
      // Штатная, частая авария: чужой сайт не отвечает, goto падает по
      // таймауту навигации.
      (browser.newPage as jest.Mock).mockRejectedValue(
        new Error('net::ERR_NAME_NOT_RESOLVED'),
      );
      const manager = new SessionManager({
        maxConcurrentSessions: 2,
        wallTimeoutMs: 180_000,
        idleTimeoutMs: 60_000,
        resultCacheMs: 60_000,
        navTimeoutMs: 20_000,
        logger,
        launchBrowser: async () => browser,
      });

      await expect(
        manager.createSession(
          'https://unreachable.example/login',
          'https://unreachable.example',
        ),
      ).rejects.toThrow('ERR_NAME_NOT_RESOLVED');

      expect(browser.close).toHaveBeenCalledTimes(1);
      // И место под потолком MAX_CONCURRENT_SESSIONS при этом не занято.
      expect(manager.activeCount).toBe(0);
    },
  );

  it(
    'повторный finalize НЕ продлевает окно выселения ' +
      '(этап 108 — иначе поллингом /result запись с куками жила бы в ' +
      'памяти процесса неограниченно долго)',
    async () => {
      const manager = makeManager({ resultCacheMs: 1000 });
      const session = await manager.createSession(
        'https://example.com/login',
        'https://example.com',
      );
      session.state = 'streaming';
      await manager.finalizeSession(session.id);

      // Дёргаем /result ещё раз почти в конце окна кэша — до фикса это
      // заводило НОВЫЙ таймер на полные resultCacheMs от этого момента.
      jest.advanceTimersByTime(900);
      await manager.finalizeSession(session.id);

      // Исходный срок (1000 мс от закрытия) должен наступить как ни в
      // чём не бывало.
      jest.advanceTimersByTime(101);
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

/**
 * Второй проход аудита этапа 108 — TOCTOU на потолке одновременных
 * сессий: проверка `activeCount >= max` стояла перед многосекундным
 * `launchBrowser()`, поэтому запросы, пришедшие в одно окно, все видели
 * нулевой счётчик и все проходили. Потолок, существующий ровно затем,
 * чтобы ограничить число Chromium в контейнере, на всплеске не работал.
 */
describe('SessionManager — потолок при одновременных запросах (этап 108)', () => {
  // Фейковые таймеры, как и в основном describe выше: созданные сессии
  // взводят wall/idle-таймеры на минуты вперёд, и на реальных таймерах
  // они держали бы event loop открытым до конца прогона.
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('из пяти одновременных createSession проходят ровно maxConcurrentSessions', async () => {
    const started: Array<() => void> = [];
    const manager = new SessionManager({
      maxConcurrentSessions: 2,
      wallTimeoutMs: 180_000,
      idleTimeoutMs: 60_000,
      resultCacheMs: 60_000,
      navTimeoutMs: 20_000,
      logger,
      // Запуск браузера «висит», пока тест его не отпустит — именно это
      // окно и было дырой: все пятеро успевали пройти проверку до того,
      // как хоть один браузер реально поднялся.
      launchBrowser: () =>
        new Promise((resolve) => {
          started.push(() => resolve(makeFakeBrowser()));
        }),
    });

    const attempts = Array.from({ length: 5 }, () =>
      manager
        .createSession('https://example.com/login', 'https://example.com')
        .then(
          () => 'ok' as const,
          (err) => (err instanceof SessionLimitError ? 'limited' : 'error'),
        ),
    );

    // Отпускаем все зависшие запуски.
    await Promise.resolve();
    for (const release of started) release();
    const results = await Promise.all(attempts);

    expect(results.filter((r) => r === 'ok')).toHaveLength(2);
    expect(results.filter((r) => r === 'limited')).toHaveLength(3);
    expect(manager.activeCount).toBe(2);
  });

  it('неудачный запуск освобождает место под потолком', async () => {
    const manager = new SessionManager({
      maxConcurrentSessions: 1,
      wallTimeoutMs: 180_000,
      idleTimeoutMs: 60_000,
      resultCacheMs: 60_000,
      navTimeoutMs: 20_000,
      logger,
      launchBrowser: async () => {
        throw new Error('chromium не стартовал');
      },
    });
    await expect(
      manager.createSession('https://example.com/login', 'https://example.com'),
    ).rejects.toThrow('chromium не стартовал');
    expect(manager.activeCount).toBe(0);
  });
});

/**
 * Этап 109 — находки аудита бизнес-процесса (не технические сбои, а
 * «фича делает не то, ради чего заведена»).
 */
describe('SessionManager — таймаут не должен стоить пользователю кук (этап 109)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('после wall-таймаута GET /result отдаёт снятые куки, а не 410', async () => {
    const manager = makeManager({ wallTimeoutMs: 1000, resultCacheMs: 60_000 });
    const session = await manager.createSession(
      'https://example.com/login',
      'https://example.com',
    );
    session.state = 'streaming';

    jest.advanceTimersByTime(1001);
    await flushMicrotasks();
    expect(session.state).toBe('closed');

    // Человек прошёл капчу и 2FA, но нажал «Готово, я вошёл» на секунду
    // позже потолка. До фикса здесь был SessionAlreadyClosedError → 410,
    // и вся его работа пропадала.
    const result = await manager.finalizeSession(session.id);
    expect(result).toEqual({
      cookies: [],
      finalUrl: 'https://example.com/',
    });
  });

  it('после idle-таймаута — то же самое', async () => {
    const manager = makeManager({
      idleTimeoutMs: 1000,
      wallTimeoutMs: 180_000,
      resultCacheMs: 60_000,
    });
    const session = await manager.createSession(
      'https://example.com/login',
      'https://example.com',
    );
    session.state = 'streaming';

    jest.advanceTimersByTime(1001);
    await flushMicrotasks();

    await expect(manager.finalizeSession(session.id)).resolves.toMatchObject({
      finalUrl: 'https://example.com/',
    });
  });

  it('отмена пользователем куки НЕ снимает — он сам отказался', async () => {
    const manager = makeManager({ resultCacheMs: 60_000 });
    const session = await manager.createSession(
      'https://example.com/login',
      'https://example.com',
    );
    session.state = 'streaming';

    await manager.cancelSession(session.id);

    await expect(manager.finalizeSession(session.id)).rejects.toBeInstanceOf(
      SessionAlreadyClosedError,
    );
  });

  it('сессия, до которой WS так и не дошёл, кук не оставляет', async () => {
    const manager = makeManager({ wallTimeoutMs: 1000, resultCacheMs: 60_000 });
    const session = await manager.createSession(
      'https://example.com/login',
      'https://example.com',
    );
    // state остаётся 'created' — человека за рулём не было вовсе.
    jest.advanceTimersByTime(1001);
    await flushMicrotasks();

    await expect(manager.finalizeSession(session.id)).rejects.toBeInstanceOf(
      SessionAlreadyClosedError,
    );
  });
});

describe('SessionManager — предупреждение о скором закрытии (этап 109)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('предупреждает за 30с до idle-закрытия и ровно один раз', async () => {
    const manager = makeManager({
      idleTimeoutMs: 40_000,
      wallTimeoutMs: 180_000,
    });
    const session = await manager.createSession(
      'https://example.com/login',
      'https://example.com',
    );
    const channel = { send: jest.fn(), close: jest.fn() };
    await session.attachWs(channel);

    // 15с без активности — до порога предупреждения (40-30=10с) ещё далеко.
    jest.advanceTimersByTime(5_000);
    expect(channel.send).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'expiring' }),
    );

    // Переваливаем порог: остаётся меньше 30с.
    jest.advanceTimersByTime(10_000);
    const warnings = channel.send.mock.calls.filter(
      (c) => (c[0] as { type: string }).type === 'expiring',
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0][0]).toMatchObject({ reason: 'idle-timeout' });

    // Ещё тики — повторных предупреждений быть не должно.
    jest.advanceTimersByTime(10_000);
    expect(
      channel.send.mock.calls.filter(
        (c) => (c[0] as { type: string }).type === 'expiring',
      ),
    ).toHaveLength(1);
  });

  it('активность человека сбрасывает предупреждение — следующая пауза предупредит снова', async () => {
    const manager = makeManager({
      idleTimeoutMs: 40_000,
      wallTimeoutMs: 180_000,
    });
    const session = await manager.createSession(
      'https://example.com/login',
      'https://example.com',
    );
    const channel = { send: jest.fn(), close: jest.fn() };
    await session.attachWs(channel);

    jest.advanceTimersByTime(15_000); // предупреждение №1
    session.markActivity(); // человек вернулся
    jest.advanceTimersByTime(15_000); // снова замер → предупреждение №2

    expect(
      channel.send.mock.calls.filter(
        (c) => (c[0] as { type: string }).type === 'expiring',
      ),
    ).toHaveLength(2);
  });
});
