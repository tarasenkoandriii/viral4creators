import {
  SITES_CALLER_TUTORIAL,
  verifySitesRequest,
} from '../../common/sites-internal-signature';
import {
  SitesInternalClient,
  SitesNotConfiguredError,
  SitesRejectedError,
  SitesUnavailableError,
  sitesBackendOrigin,
  sitesTelegramId,
} from './sites-internal.client';

const SECRET = 'q'.repeat(40);
const NOW = new Date('2026-10-05T12:00:00Z');

function client(
  respond: (url: string, init: RequestInit) => Promise<Response> | Response,
  env: NodeJS.ProcessEnv = {
    SITES_BACKEND_URL: 'https://sites.example.app/',
    SITES_TUTORIAL_HMAC_SECRET: SECRET,
  },
) {
  const c = new SitesInternalClient();
  const calls: Array<{ url: string; init: RequestInit }> = [];
  c.env = env;
  c.now = () => NOW;
  c.fetchImpl = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(respond(url, init));
  }) as typeof fetch;
  return { c, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const STATUS = {
  mode: 'B',
  host: 'shop.example.com',
  registrableDomain: 'example.com',
  hostId: null,
  status: 'none',
  expiresAt: null,
  optedOut: false,
  reason: 'no_account',
};

describe('SitesInternalClient (П-С3)', () => {
  it('запрос подписан так, что его принимает проверка sites-backend', async () => {
    const { c, calls } = client(() =>
      json(200, { success: true, data: STATUS }),
    );
    await expect(
      c.hostStatus('4242', 'https://shop.example.com'),
    ).resolves.toEqual(STATUS);
    const { url, init } = calls[0];
    expect(url).toBe(
      'https://sites.example.app/internal/sites/tutorial/host-status',
    );
    const check = verifySitesRequest(SECRET, {
      method: init.method!,
      path: new URL(url).pathname,
      body: init.body as string,
      headers: init.headers as Record<string, string>,
      nowSeconds: Math.floor(NOW.getTime() / 1000),
      expectedCaller: SITES_CALLER_TUTORIAL,
    });
    expect(check.ok).toBe(true);
    expect(JSON.parse(init.body as string)).toEqual({
      telegramId: '4242',
      url: 'https://shop.example.com',
    });
    // Секрет по сети не ходит.
    expect(JSON.stringify(init.headers)).not.toContain(SECRET);
  });

  it('каждый вызов — новый id запроса (повтор после таймаута — не «повтор»)', async () => {
    const { c, calls } = client(() => json(200, { data: STATUS }));
    await c.hostStatus('1', 'https://a.example.com');
    await c.hostStatus('1', 'https://a.example.com');
    const ids = calls.map(
      (x) => (x.init.headers as Record<string, string>)['x-sites-request-id'],
    );
    expect(new Set(ids).size).toBe(2);
  });

  it('не настроено (нет адреса, короткий секрет, http не localhost) — SitesNotConfiguredError без сети', async () => {
    for (const env of [
      { SITES_TUTORIAL_HMAC_SECRET: SECRET },
      {
        SITES_BACKEND_URL: 'https://s.example.app',
        SITES_TUTORIAL_HMAC_SECRET: 'short',
      },
      {
        SITES_BACKEND_URL: 'http://s.example.app',
        SITES_TUTORIAL_HMAC_SECRET: SECRET,
      },
    ]) {
      const { c, calls } = client(() => json(200, {}), env);
      expect(c.configured()).toBe(false);
      await expect(
        c.hostStatus('1', 'https://a.example.com'),
      ).rejects.toBeInstanceOf(SitesNotConfiguredError);
      expect(calls).toHaveLength(0);
    }
  });

  it('4xx с кодом — SitesRejectedError; 401/5xx/сеть — SitesUnavailableError', async () => {
    const rejected = client(() =>
      json(400, { error: { code: 'HOST_INVALID', message: 'только https' } }),
    );
    const e = await rejected.c
      .registerHost('1', 'http://a.example.com')
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(SitesRejectedError);
    expect(e).toMatchObject({ status: 400, code: 'HOST_INVALID' });

    for (const r of [
      () => json(401, { error: { code: 'INTERNAL_SIGNATURE_MISMATCH' } }),
      () => json(503, {}),
      () => Promise.reject(new Error('ECONNREFUSED')),
      () => json(200, { data: null }),
    ]) {
      const { c } = client(r as () => Response);
      await expect(
        c.hostStatus('1', 'https://a.example.com'),
      ).rejects.toBeInstanceOf(SitesUnavailableError);
    }
  });

  it('тело ответа зависло после заголовков — таймаут, SitesUnavailableError (не вечное ожидание)', async () => {
    jest.useFakeTimers();
    try {
      const { c } = client(
        (_u, init) =>
          ({
            ok: true,
            status: 200,
            // Тело читается, пока запрос не прервут, — как у fetch.
            json: () =>
              new Promise((_res, rej) =>
                init.signal?.addEventListener('abort', () =>
                  rej(new Error('AbortError')),
                ),
              ),
          }) as unknown as Response,
      );
      const p = c.hostStatus('4242', 'https://shop.example.com');
      const settled = p.then(
        () => 'resolved',
        (e: unknown) => e,
      );
      await jest.advanceTimersByTimeAsync(6_000);
      await expect(settled).resolves.toBeInstanceOf(SitesUnavailableError);
    } finally {
      jest.useRealTimers();
    }
  });

  it('адрес sites-backend и Telegram-id — по правилам', () => {
    expect(
      sitesBackendOrigin({ SITES_BACKEND_URL: 'http://localhost:3002/x' }),
    ).toBe('http://localhost:3002');
    expect(sitesBackendOrigin({ SITES_BACKEND_URL: 'не адрес' })).toBeNull();
    expect(sitesTelegramId('123')).toBe('123');
    for (const bad of ['dev-1', '0', '', null, undefined, '01']) {
      expect(sitesTelegramId(bad)).toBeNull();
    }
  });
});

describe('SitesInternalClient: хранилище учётных данных (Э-С Ш2)', () => {
  it('аренда → погашение: два подписанных запроса, секреты из второго', async () => {
    const { c, calls } = client((url) =>
      url.endsWith('/lease')
        ? json(200, { success: true, data: { leaseId: 'L1' } })
        : json(200, {
            success: true,
            data: { secrets: { 'login-fields': '[]' } },
          }),
    );
    await expect(
      c.leaseSecrets('4242', {
        testAccountId: 'ta1',
        hostId: 'h1',
        runRef: 'draft:d1',
      }),
    ).resolves.toEqual({ 'login-fields': '[]' });
    expect(calls.map((x) => new URL(x.url).pathname)).toEqual([
      '/internal/sites/credentials/lease',
      '/internal/sites/credentials/lease/redeem',
    ]);
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      telegramId: '4242',
      testAccountId: 'ta1',
      hostId: 'h1',
      product: 'tutorial',
      runRef: 'draft:d1',
    });
    expect(JSON.parse(calls[1].init.body as string)).toEqual({
      telegramId: '4242',
      leaseId: 'L1',
    });
    for (const call of calls) {
      expect(
        verifySitesRequest(SECRET, {
          method: 'POST',
          path: new URL(call.url).pathname,
          body: call.init.body as string,
          headers: call.init.headers as Record<string, string>,
          nowSeconds: Math.floor(NOW.getTime() / 1000),
          expectedCaller: SITES_CALLER_TUTORIAL,
        }).ok,
      ).toBe(true);
    }
  });

  it('503 CREDENTIALS_NOT_CONFIGURED — недоступность с кодом (генератор пишет в колонки)', async () => {
    const { c } = client(() =>
      json(503, {
        success: false,
        error: { code: 'CREDENTIALS_NOT_CONFIGURED', message: 'нет ключей' },
      }),
    );
    const err = await c
      .upsertUserSession('gen:u1', { origin: 'https://a.example.com' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SitesUnavailableError);
    expect((err as SitesUnavailableError).code).toBe(
      'CREDENTIALS_NOT_CONFIGURED',
    );
  });

  it('отказ аренды (403) — SitesRejectedError с кодом; не настроен — SitesNotConfiguredError', async () => {
    const { c } = client(() =>
      json(403, {
        success: false,
        error: { code: 'CREDENTIAL_LEASE_DENIED', message: 'хост' },
      }),
    );
    await expect(
      c.leaseSecrets('1', { testAccountId: 'a', hostId: 'h' }),
    ).rejects.toMatchObject({ code: 'CREDENTIAL_LEASE_DENIED', status: 403 });
    const { c: off } = client(() => json(200, {}), {});
    await expect(off.credentialsStatus()).rejects.toBeInstanceOf(
      SitesNotConfiguredError,
    );
  });
});
