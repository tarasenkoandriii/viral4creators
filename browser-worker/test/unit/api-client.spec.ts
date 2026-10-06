import { createApiClient } from '../../src/api-client';
import {
  WORKER_CALLER,
  WORKER_ROUTES,
} from '../../src/shared/browser-job-protocol';
import { verifySitesRequest } from '../../src/shared/sites-internal-signature';

const SECRET = 'x'.repeat(40);

describe('клиент API воркера: подпись HMAC', () => {
  it('каждый запрос подписан своим секретом и вызывающим browser-worker; подделка тела не проходит', async () => {
    const seen: Array<{
      path: string;
      headers: Record<string, string>;
      body: string;
    }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({
        path: new URL(url).pathname,
        headers: init.headers as Record<string, string>,
        body: String(init.body),
      });
      return new Response(
        JSON.stringify({ success: true, data: { enabled: true, jobs: [] } }),
      );
    }) as unknown as typeof fetch;
    const api = createApiClient({
      baseUrl: 'https://sites.test',
      secret: SECRET,
      workerId: 'bw-unit',
      fetchImpl,
    });
    await api.claim(['ui-snapshot'], 2);
    const r = seen[0];
    expect(r.path).toBe(WORKER_ROUTES.claim);
    expect(r.body).not.toContain(SECRET);
    expect(Object.values(r.headers).join(' ')).not.toContain(SECRET);
    const now = Math.floor(Date.now() / 1000);
    const ok = verifySitesRequest(SECRET, {
      method: 'POST',
      path: r.path,
      body: r.body,
      headers: r.headers,
      nowSeconds: now,
      expectedCaller: WORKER_CALLER,
    });
    expect(ok.ok).toBe(true);
    const tampered = verifySitesRequest(SECRET, {
      method: 'POST',
      path: r.path,
      body: r.body.replace('2', '4'),
      headers: r.headers,
      nowSeconds: now,
      expectedCaller: WORKER_CALLER,
    });
    expect(tampered).toEqual({ ok: false, reason: 'mismatch' });
    const otherCaller = verifySitesRequest(SECRET, {
      method: 'POST',
      path: r.path,
      body: r.body,
      headers: r.headers,
      nowSeconds: now,
      expectedCaller: 'qa-flow',
    });
    expect(otherCaller).toEqual({ ok: false, reason: 'caller' });
  });

  it('ошибка сервера — ApiError с машинным кодом', async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          success: false,
          error: { code: 'WORKER_LEASE_LOST' },
        }),
        { status: 409 },
      )) as unknown as typeof fetch;
    const api = createApiClient({
      baseUrl: 'https://sites.test',
      secret: SECRET,
      workerId: 'bw-unit',
      fetchImpl,
    });
    await expect(api.heartbeat('j1', 'a'.repeat(43))).rejects.toMatchObject({
      status: 409,
      code: 'WORKER_LEASE_LOST',
    });
  });

  it('аудит Ш3: редиректы не исполняются (подписанный запрос не уходит дальше)', async () => {
    const inits: RequestInit[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      inits.push(init);
      return new Response(
        JSON.stringify({ success: true, data: { ok: true, cancel: false } }),
      );
    }) as unknown as typeof fetch;
    const api = createApiClient({
      baseUrl: 'https://sites.test',
      secret: SECRET,
      workerId: 'bw-unit',
      fetchImpl,
    });
    await api.heartbeat('job-1', 't'.repeat(43));
    await api.claim(['ui-snapshot'], 1);
    expect(inits.map((i) => i.redirect)).toEqual(['error', 'error']);
  });
});
