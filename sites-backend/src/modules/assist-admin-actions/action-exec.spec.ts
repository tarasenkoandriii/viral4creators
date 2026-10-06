/**
 * Исполнение изменяющей операции после «Да» (Э8, ТЗ §5.5, §5.7) на
 * настоящем pinnedFetch поверх https-стенда: SSRF-guard (allowedHosts,
 * частный IP, редирект не исполняется), без автоповтора (5xx/таймаут —
 * unknown), 4xx — текст ошибки без секрета и ПД, заголовки
 * Idempotency-Key / X-V4C-Actor / X-V4C-Signature, тело — по схеме.
 */
import { createHmac } from 'crypto';
import {
  LocalSites,
  PUBLIC_TEST_IP,
} from '../site-crawl/testing/local-sites.testing';
import type { OperationParam } from '../assist-admin-mode/openapi-import';
import {
  actorHeaderValue,
  executeWrite,
  maskBody,
  type WriteRequest,
} from './action-exec';

const API = 'apiw.polygon.example';
const SECRET = 'MARKER-SECRET-e8-exec-91ab';
const PARAMS: OperationParam[] = [
  { name: 'id', in: 'path', required: true, type: 'string' },
  {
    name: 'status',
    in: 'body',
    required: true,
    type: 'string',
    enum: ['paid', 'shipped'],
  },
  {
    name: 'ids',
    in: 'body',
    required: false,
    type: 'array',
    items: 'string',
    maxItems: 3,
  },
];

describe('action-exec: executeWrite', () => {
  const net = new LocalSites();
  const mask = (s: string) => s.replace(/[\w.+-]+@[\w.-]+/g, '[email]');
  let hits = 0;

  beforeAll(async () => {
    await net.start();
    net.site(API, {
      '/v1/orders/1': (_req, body) => {
        hits++;
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ok: true, got: JSON.parse(body) }),
        };
      },
      '/v1/orders/500': () => {
        hits++;
        return { status: 503, body: 'down' };
      },
      '/v1/orders/422': () => ({
        status: 422,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          message: `Bad status for client a.b@shop.ua, key ${SECRET}`,
        }),
      }),
      '/v1/orders/401': { status: 401, body: '{}' },
      '/v1/orders/401k': {
        status: 401,
        headers: { 'www-authenticate': 'Bearer error="invalid_token"' },
        body: '{}',
      },
      '/v1/orders/403': {
        status: 403,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: 'ACTOR_INVALID', message: 'actor' }),
      },
      '/v1/orders/302': {
        status: 302,
        headers: { location: 'https://evil.example/steal' },
        body: '',
      },
      '/v1/orders/slow': { status: 200, body: '{}', delayMs: 800 },
    });
    net.dns.set('private.polygon.example', ['10.0.0.7']);
  });
  afterAll(() => net.stop());

  const req = (over: Partial<WriteRequest> = {}): WriteRequest => ({
    baseUrl: `https://${API}/v1`,
    allowedHosts: [API],
    method: 'PATCH',
    path: '/orders/{id}',
    params: PARAMS,
    args: { id: '1', status: 'shipped' },
    auth: { kind: 'bearer', secret: SECRET },
    actor: 'emp-A',
    idempotencyKey: 'prop-1',
    signSecret: 'sign-secret',
    nowSec: 1_760_000_000,
    timeoutMs: 400,
    ...over,
  });

  it('2xx — done; заголовки идемпотентности, исполнителя, подписи; тело — только параметры body', async () => {
    const before = net.requests.length;
    const r = await executeWrite(req(), net.deps(), mask);
    expect(r).toMatchObject({ status: 'done', outcome: 'ok', httpStatus: 200 });
    const seen = net.requests.slice(before);
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe('PATCH');
    expect(seen[0].body).toBe('{"status":"shipped"}');
    expect(seen[0].headers['idempotency-key']).toBe('prop-1');
    expect(seen[0].headers['x-v4c-actor']).toBe('emp-A');
    expect(seen[0].headers['content-type']).toBe('application/json');
    const v1 = createHmac('sha256', 'sign-secret')
      .update('1760000000.PATCH.prop-1./v1/orders/1.{"status":"shipped"}')
      .digest('hex');
    expect(seen[0].headers['x-v4c-signature']).toBe(`t=1760000000,v1=${v1}`);
    expect(r.requestMasked).toEqual({
      method: 'PATCH',
      path: '/orders/1',
      query: {},
      body: { status: 'shipped' },
    });
  });

  it('аудит Э8: sub сотрудника кириллицей — X-V4C-Actor кодируется, запрос уходит (не ложный unknown)', async () => {
    const before = net.requests.length;
    const r = await executeWrite(
      req({ actor: 'Олена.K%1', idempotencyKey: 'prop-cyr' }),
      net.deps(),
      mask,
    );
    expect(r).toMatchObject({ status: 'done', outcome: 'ok' });
    const seen = net.requests.slice(before);
    expect(seen).toHaveLength(1);
    expect(seen[0].headers['x-v4c-actor']).toBe(
      `${encodeURIComponent('Олена')}.K%251`,
    );
    expect(decodeURIComponent(String(seen[0].headers['x-v4c-actor']))).toBe(
      'Олена.K%1',
    );
    expect(actorHeaderValue('tg:123')).toBe('tg:123');
    expect(actorHeaderValue('a\r\nX-Evil: 1')).toBe('a%0D%0AX-Evil:%201');
    expect(actorHeaderValue('\ud83d\ude00'.repeat(200))).toHaveLength(128 * 12);
  });

  it('5xx — unknown БЕЗ автоповтора (один запрос)', async () => {
    hits = 0;
    const r = await executeWrite(
      req({ args: { id: '500', status: 'paid' } }),
      net.deps(),
      mask,
    );
    expect(r).toMatchObject({
      status: 'unknown',
      outcome: 'unknown',
      httpStatus: 503,
    });
    expect(hits).toBe(1);
  });

  it('таймаут — unknown (могло примениться), без повтора', async () => {
    const before = net.requests.length;
    const r = await executeWrite(
      req({ args: { id: 'slow', status: 'paid' } }),
      net.deps(),
      mask,
    );
    expect(r).toMatchObject({ status: 'unknown', outcome: 'timeout' });
    await new Promise((res) => setTimeout(res, 500));
    expect(net.requests.length - before).toBe(1);
  });

  it('4xx — failed, текст ошибки API: без секрета и ПД; 401 — auth_failed', async () => {
    const r = await executeWrite(
      req({ args: { id: '422', status: 'paid' } }),
      net.deps(),
      mask,
    );
    expect(r.status).toBe('failed');
    expect(r.errorText).toContain('Bad status');
    expect(r.errorText).not.toContain(SECRET);
    expect(r.errorText).not.toContain('a.b@shop.ua');
    const a = await executeWrite(
      req({ args: { id: '401k', status: 'paid' } }),
      net.deps(),
      mask,
    );
    expect(a).toMatchObject({
      status: 'failed',
      outcome: 'auth_failed',
      authReject: 'key',
    });
    // Аудит Н-3: голый 401 — неясно (ключ или сотрудник), 403 — отказ по
    // сотруднику: обычный failed, коннектор не паузится.
    const u = await executeWrite(
      req({ args: { id: '401', status: 'paid' } }),
      net.deps(),
      mask,
    );
    expect(u).toMatchObject({
      status: 'failed',
      outcome: 'http_error',
      authReject: 'unclear',
    });
    const f = await executeWrite(
      req({ args: { id: '403', status: 'paid' } }),
      net.deps(),
      mask,
    );
    expect(f).toMatchObject({ status: 'failed', outcome: 'http_error' });
    expect(f.authReject).toBeUndefined();
  });

  it('3xx — редирект не исполняется (unknown), на чужой хост не идём', async () => {
    const before = net.lookups.length;
    const r = await executeWrite(
      req({ args: { id: '302', status: 'paid' } }),
      net.deps(),
      mask,
    );
    expect(r).toMatchObject({ status: 'unknown', error: 'redirect' });
    expect(net.lookups.slice(before)).not.toContain('evil.example');
  });

  it('SSRF: хост вне allowedHosts и частный IP — без сети; параметры не по схеме — без сети', async () => {
    const before = net.requests.length;
    const off = await executeWrite(
      req({ baseUrl: 'https://evil.example/v1' }),
      net.deps(),
      mask,
    );
    expect(off).toMatchObject({
      status: 'failed',
      outcome: 'blocked',
      error: 'host_not_allowed',
    });
    const priv = await executeWrite(
      req({
        baseUrl: 'https://private.polygon.example/v1',
        allowedHosts: ['private.polygon.example'],
      }),
      net.deps(),
      mask,
    );
    expect(priv).toMatchObject({
      status: 'failed',
      outcome: 'blocked',
      error: 'ssrf',
    });
    for (const args of [
      { id: '1', status: 'deleted' },
      { id: '../admin', status: 'paid' },
      { id: '1', status: 'paid', extra: 1 },
      { id: '1', status: 'paid', ids: ['a', 'b', 'c', 'd'] },
      { id: '1', status: { $ne: 1 } },
    ]) {
      const r = await executeWrite(req({ args }), net.deps(), mask);
      expect(r).toMatchObject({ status: 'failed', outcome: 'invalid_params' });
    }
    const get = await executeWrite(req({ method: 'GET' }), net.deps(), mask);
    expect(get.outcome).toBe('blocked');
    expect(net.requests.length).toBe(before);
    expect(PUBLIC_TEST_IP).toBeTruthy();
  });

  it('маска тела журнала: строки — маской, числа и флаги — как есть', () => {
    expect(
      maskBody(
        { email: 'a.b@shop.ua', n: 5, ok: true, list: ['x@y.ua'] },
        mask,
      ),
    ).toEqual({ email: '[email]', n: 5, ok: true, list: ['[email]'] });
  });
});
