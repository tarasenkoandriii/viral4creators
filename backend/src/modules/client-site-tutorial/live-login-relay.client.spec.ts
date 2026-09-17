/**
 * Клиент реле живого входа (§7/§15 doc/LIVE-LOGIN-RELAY-SPEC.md, этап 114).
 *
 * Тесты написаны по §15 — списку граблей, который аудит составил
 * ЗАРАНЕЕ, пока backend-стороны ещё не существовало. Каждый пункт
 * оттуда закрыт тестом здесь: иначе «правило, которое теперь есть»
 * осталось бы правилом в документе, а не в коде.
 */

import {
  LiveLoginRelayClient,
  RelaySessionGoneError,
  RelayNotConfiguredError,
  RelayUnavailableError,
} from './live-login-relay.client';

const env = { ...process.env };
afterEach(() => {
  process.env = { ...env };
  jest.restoreAllMocks();
});

function configure(over: Record<string, string> = {}) {
  process.env.LIVE_LOGIN_RELAY_URL = 'https://relay.example';
  process.env.LIVE_LOGIN_RELAY_SECRET = 'секрет';
  delete process.env.LIVE_LOGIN_RELAY_WS_URL;
  Object.assign(process.env, over);
  return new LiveLoginRelayClient();
}

function mockFetch(
  impl: (url: string, init: RequestInit) => Promise<Response> | Response,
): jest.Mock {
  const fn = jest.fn(impl as never);
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const START = {
  startUrl: 'https://shop.example.com/login',
  allowedOrigin: 'https://shop.example.com',
};

describe('мягкая деградация (§15.8)', () => {
  it('без переменных — не настроено, и это ЯВНЫЙ признак', () => {
    delete process.env.LIVE_LOGIN_RELAY_URL;
    delete process.env.LIVE_LOGIN_RELAY_SECRET;
    expect(new LiveLoginRelayClient().configured()).toBe(false);
  });

  it('половина переменных — тоже не настроено', () => {
    process.env.LIVE_LOGIN_RELAY_URL = 'https://relay.example';
    delete process.env.LIVE_LOGIN_RELAY_SECRET;
    expect(new LiveLoginRelayClient().configured()).toBe(false);
  });

  it('вызов без настройки — своя ошибка, а не «реле не ответило»', async () => {
    delete process.env.LIVE_LOGIN_RELAY_URL;
    await expect(
      new LiveLoginRelayClient().createSession(START),
    ).rejects.toBeInstanceOf(RelayNotConfiguredError);
  });
});

describe('старт сессии', () => {
  it('секрет уходит заголовком, тело — как есть', async () => {
    const client = configure();
    const fetchMock = mockFetch(() =>
      json(
        { sessionId: 's1', streamToken: 't1', wsPath: '/sessions/s1/stream' },
        201,
      ),
    );
    await client.createSession(START);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://relay.example/sessions');
    expect((init.headers as Record<string, string>)['X-Relay-Secret']).toBe(
      'секрет',
    );
    expect(JSON.parse(init.body as string)).toEqual(START);
  });

  it('wss-адрес собирается сами — реле своего хоста не знает (§15.3)', async () => {
    const client = configure();
    mockFetch(() =>
      json(
        { sessionId: 's1', streamToken: 't1', wsPath: '/sessions/s1/stream' },
        201,
      ),
    );
    const session = await client.createSession(START);
    expect(session.relayWsUrl).toBe('wss://relay.example/sessions/s1/stream');
  });

  it('отдельная WS-переменная перекрывает склейку — внутренний адрес ≠ публичный', async () => {
    const client = configure({
      LIVE_LOGIN_RELAY_URL: 'http://relay.internal:3000',
      LIVE_LOGIN_RELAY_WS_URL: 'wss://relay.example',
    });
    mockFetch(() =>
      json(
        { sessionId: 's1', streamToken: 't1', wsPath: '/sessions/s1/stream' },
        201,
      ),
    );
    const session = await client.createSession(START);
    expect(session.relayWsUrl).toBe('wss://relay.example/sessions/s1/stream');
  });

  it('502 НЕ ретраится — повтор поднял бы второй браузер (§15.5)', async () => {
    const client = configure();
    const fetchMock = mockFetch(() => json({}, 502));
    await expect(client.createSession(START)).rejects.toBeInstanceOf(
      RelayUnavailableError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('503 — «перегружено», понятным текстом', async () => {
    const client = configure();
    mockFetch(() => json({}, 503));
    await expect(client.createSession(START)).rejects.toThrow(/перегружен/);
  });

  it('401 — про настройку, а не про пользователя', async () => {
    const client = configure();
    mockFetch(() => json({}, 401));
    await expect(client.createSession(START)).rejects.toThrow(/секрет/);
  });

  it('таймаут старта заведомо больше навигационного таймаута реле (§15.4)', async () => {
    // Реле ждёт goto на чужом сайте до 20с. Сдаться раньше — значит
    // показать ошибку и при этом оставить реле держать живой браузер и
    // место под потолком все три минуты.
    const client = configure();
    let seen = 0;
    jest.spyOn(global, 'setTimeout').mockImplementation(((
      fn: () => void,
      ms: number,
    ) => {
      seen = Math.max(seen, ms);
      return 0 as unknown as NodeJS.Timeout;
    }) as never);
    mockFetch(() =>
      json({ sessionId: 's1', streamToken: 't1', wsPath: '/p' }, 201),
    );
    await client.createSession(START);
    expect(seen).toBeGreaterThan(20_000);
  });
});

describe('результат сессии', () => {
  it('отдаёт куки и финальный адрес', async () => {
    const client = configure();
    mockFetch(() =>
      json({
        cookies: [{ name: 'sid' }],
        finalUrl: 'https://shop.example.com/cabinet',
      }),
    );
    const result = await client.fetchResult('s1');
    expect(result.finalUrl).toBe('https://shop.example.com/cabinet');
    expect(result.cookies).toHaveLength(1);
  });

  it('410 — «начните заново», а НЕ повод повторить (§15.1)', async () => {
    // Код не описан ни в одном документе, а встретится первым: реле
    // отвечает им, когда сессию уже закрыли по таймауту или отмене.
    const client = configure();
    const fetchMock = mockFetch(() => json({}, 410));
    await expect(client.fetchResult('s1')).rejects.toBeInstanceOf(
      RelaySessionGoneError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('404 — тоже «сессии больше нет», а не загадка', async () => {
    const client = configure();
    mockFetch(() => json({}, 404));
    await expect(client.fetchResult('s1')).rejects.toBeInstanceOf(
      RelaySessionGoneError,
    );
  });

  it('идентификатор сессии экранируется в пути', async () => {
    const client = configure();
    const fetchMock = mockFetch(() => json({ cookies: [], finalUrl: 'x' }));
    await client.fetchResult('a/b?c');
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://relay.example/sessions/a%2Fb%3Fc/result',
    );
  });
});

describe('отмена', () => {
  it('204 разбирается как успех, а не как пустой JSON', async () => {
    const client = configure();
    mockFetch(() => new Response(null, { status: 204 }));
    await expect(client.cancelQuietly('s1')).resolves.toBeUndefined();
  });

  it('сбой отмены не бросает наружу — она best-effort', async () => {
    // Таймауты реле дадут тот же результат чуть позже; ронять из-за
    // неудавшейся уборки основной сценарий нельзя.
    const client = configure();
    mockFetch(() => {
      throw new Error('сеть');
    });
    await expect(client.cancelQuietly('s1')).resolves.toBeUndefined();
  });

  it('без идентификатора не ходит никуда', async () => {
    const client = configure();
    const fetchMock = mockFetch(() => new Response(null, { status: 204 }));
    await client.cancelQuietly(undefined);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('секреты не попадают в журнал (§15.6)', () => {
  it('ни тело запроса, ни тело ответа не логируются', async () => {
    // Через этот канал летят пароли (человек набирает их в РЕАЛЬНОЙ
    // странице) и куки живой сессии.
    const client = configure();
    const warn = jest
      .spyOn(
        (client as unknown as { logger: { warn: (m: string) => void } }).logger,
        'warn',
      )
      .mockImplementation(() => undefined);
    mockFetch(
      () => new Response('{"cookies":[{"value":"СЕКРЕТ"}]}', { status: 500 }),
    );

    await expect(client.fetchResult('s1')).rejects.toBeTruthy();

    const logged = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).not.toContain('СЕКРЕТ');
    expect(logged).not.toContain('секрет');
    expect(logged).toContain('500');
  });
});
