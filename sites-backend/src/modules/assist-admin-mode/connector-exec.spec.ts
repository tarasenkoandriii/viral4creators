/**
 * Исполнение read-операции коннектора (Э7, ТЗ §5.5, §5.7) на настоящем
 * pinnedFetch поверх локального https-стенда: SSRF-guard (allowedHosts,
 * редирект на чужой хост, частный IP), проверка параметров модели,
 * повтор 5xx, 401/403, не-JSON, секрет не уходит в данные.
 */
import {
  LocalSites,
  PUBLIC_TEST_IP,
} from '../site-crawl/testing/local-sites.testing';
import {
  ParamValidationError,
  authHeaderNameAllowed,
  buildUrl,
  authRejection,
  executeRead,
  hostAllowed,
  scrubSecret,
  validateArgs,
} from './connector-exec';
import type { OperationParam } from './openapi-import';

const API = 'api.polygon.example';
const SECRET = 'MARKER-SECRET-7f3a9c2e1b';
const ORDER_PARAMS: OperationParam[] = [
  { name: 'id', in: 'path', required: true, type: 'string' },
  {
    name: 'status',
    in: 'query',
    required: false,
    type: 'string',
    enum: ['new', 'paid'],
  },
];

describe('connector-exec', () => {
  const net = new LocalSites();
  const mask = (s: string) => s.replace(/@/g, '[at]');

  beforeAll(async () => {
    await net.start();
    const order = (req: import('http').IncomingMessage) => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      // API эхом возвращает заголовок авторизации — секрет не должен дойти до модели.
      body: JSON.stringify({
        id: 1042,
        status: 'paid',
        echo: req.headers.authorization,
        actor: req.headers['x-v4c-actor'],
      }),
    });
    net.site(API, {
      '/v1/orders/1042': order,
      '/v1/orders/1042?status=paid': order,
      '/v1/orders/500': { status: 503, body: 'down' },
      '/v1/orders/401': { status: 401, body: '{}' },
      '/v1/orders/401k': {
        status: 401,
        headers: { 'www-authenticate': 'Bearer error="invalid_token"' },
        body: '{}',
      },
      '/v1/orders/401c': {
        status: 401,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ error: { code: 'invalid_api_key' } }),
      },
      '/v1/orders/403': {
        status: 403,
        headers: { 'www-authenticate': 'Bearer error="insufficient_scope"' },
        body: JSON.stringify({ code: 'ACTOR_INVALID' }),
      },
      '/v1/orders/html': {
        status: 200,
        headers: { 'content-type': 'text/html' },
        body: '<html>nope</html>',
      },
      '/v1/orders/redir': {
        status: 302,
        headers: { location: 'https://evil.ssrf.example/steal' },
      },
    });
    net.site('evil.ssrf.example', { '/steal': { status: 200, body: '{}' } });
    net.dns.set('internal.polygon.example', ['10.0.0.5']);
  });

  afterAll(() => net.stop());

  const base = {
    baseUrl: `https://${API}/v1`,
    allowedHosts: [API],
    method: 'GET',
    path: '/orders/{id}',
    params: ORDER_PARAMS,
    auth: { kind: 'bearer' as const, secret: SECRET },
    actor: 'emp-17',
  };

  it('read: данные JSON, секрет вырезан из данных, журнал маскирован, X-V4C-Actor', async () => {
    const r = await executeRead(
      { ...base, args: { id: '1042', status: 'paid' } },
      net.deps(),
      mask,
      1,
    );
    expect(r.outcome).toBe('ok');
    expect(r.httpStatus).toBe(200);
    expect(r.data).toContain('"paid"');
    expect(r.data).toContain('emp-17');
    expect(r.data).not.toContain(SECRET);
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(r.requestMasked).toEqual({
      method: 'GET',
      path: '/orders/1042',
      query: { status: 'paid' },
    });
  });

  it('хост вне allowedHosts — отказ без сети', async () => {
    const hits = net.hits.length;
    const r = await executeRead(
      {
        ...base,
        allowedHosts: ['other.polygon.example'],
        args: { id: '1042' },
      },
      net.deps(),
      mask,
      1,
    );
    expect(r.outcome).toBe('blocked');
    expect(r.error).toBe('host_not_allowed');
    expect(net.hits.length).toBe(hits);
  });

  it('редирект на чужой хост не исполняется (3xx — blocked)', async () => {
    const r = await executeRead(
      { ...base, args: { id: 'redir' } },
      net.deps(),
      mask,
      1,
    );
    expect(r.outcome).toBe('blocked');
    expect(net.hits).not.toContain('evil.ssrf.example/steal');
  });

  it('имя резолвится в частный IP — отказ (IP-pin)', async () => {
    const r = await executeRead(
      {
        ...base,
        baseUrl: 'https://internal.polygon.example/v1',
        allowedHosts: ['internal.polygon.example'],
        args: { id: '1042' },
      },
      net.deps(),
      mask,
      1,
    );
    expect(r.outcome).toBe('blocked');
    expect(r.error).toBe('ssrf');
  });

  it('5xx — один повтор, затем http_error (данных нет)', async () => {
    const before = net.hits.filter((h) => h === `${API}/v1/orders/500`).length;
    const r = await executeRead(
      { ...base, args: { id: '500' } },
      net.deps(),
      mask,
      1,
    );
    expect(r.outcome).toBe('http_error');
    expect(r.httpStatus).toBe(503);
    expect(r.data).toBeNull();
    expect(
      net.hits.filter((h) => h === `${API}/v1/orders/500`).length - before,
    ).toBe(2);
  });

  it('аудит Н-3: 401 с вызовом Bearer или кодом ключа — auth_failed (key); голый 401 — http_error (unclear); 403 — http_error без паузы', async () => {
    const run = async (id: string) =>
      executeRead({ ...base, args: { id } }, net.deps(), mask, 1);
    expect(await run('401k')).toMatchObject({
      outcome: 'auth_failed',
      authReject: 'key',
      httpStatus: 401,
    });
    expect(await run('401c')).toMatchObject({
      outcome: 'auth_failed',
      authReject: 'key',
    });
    expect(await run('401')).toMatchObject({
      outcome: 'http_error',
      authReject: 'unclear',
      error: 'http_401',
    });
    const forbidden = await run('403');
    expect(forbidden).toMatchObject({ outcome: 'http_error', httpStatus: 403 });
    expect(forbidden.authReject).toBeUndefined();
  });

  it('authRejection: схема вызова и коды ключа', () => {
    const b = Buffer.from('{}');
    expect(
      authRejection(401, { 'www-authenticate': 'Bearer' }, b, 'bearer'),
    ).toBe('key');
    expect(
      authRejection(401, { 'www-authenticate': 'Basic realm="x"' }, b, 'basic'),
    ).toBe('key');
    // Basic-вызов при ключе в заголовке — не признак ключа.
    expect(
      authRejection(
        401,
        { 'www-authenticate': 'Basic realm="x"' },
        b,
        'header',
      ),
    ).toBe('unclear');
    expect(
      authRejection(401, { 'www-authenticate': 'BearerX' }, b, 'bearer'),
    ).toBe('unclear');
    expect(
      authRejection(401, {}, Buffer.from('{"code":"INVALID_TOKEN"}'), 'bearer'),
    ).toBe('key');
    expect(
      authRejection(401, {}, Buffer.from('{"code":"ACTOR_INVALID"}'), 'bearer'),
    ).toBe('unclear');
    expect(
      authRejection(403, { 'www-authenticate': 'Bearer' }, b, 'bearer'),
    ).toBeNull();
  });

  it('не JSON — bad_response', async () => {
    expect(
      (
        await executeRead(
          { ...base, args: { id: 'html' } },
          net.deps(),
          mask,
          1,
        )
      ).outcome,
    ).toBe('bad_response');
  });

  it('аргументы модели: лишний, вне enum, «..» в пути — invalid_params без сети', async () => {
    const hits = net.hits.length;
    for (const args of [
      { id: '1042', admin: 'true' },
      { id: '1042', status: 'deleted' },
      { id: '..' },
      { id: 'a/b' },
      {},
    ]) {
      const r = await executeRead({ ...base, args }, net.deps(), mask, 1);
      expect(r.outcome).toBe('invalid_params');
    }
    expect(net.hits.length).toBe(hits);
  });

  it('чистые функции: validateArgs, buildUrl, hostAllowed, scrubSecret', () => {
    expect(() => validateArgs(ORDER_PARAMS, { id: '%2e%2e' })).toThrow(
      ParamValidationError,
    );
    const p = validateArgs(ORDER_PARAMS, { id: 'A-1', status: 'new' });
    const u = buildUrl(
      'https://x.polygon.example/api',
      '/orders/{id}',
      p.path,
      p.query,
    );
    expect(u.href).toBe('https://x.polygon.example/api/orders/A-1?status=new');
    expect(
      hostAllowed(new URL('https://x.polygon.example/a'), [
        'x.polygon.example',
      ]),
    ).toBe(true);
    expect(
      hostAllowed(new URL('https://y.x.polygon.example/a'), [
        'x.polygon.example',
      ]),
    ).toBe(false);
    expect(
      hostAllowed(new URL('http://x.polygon.example/a'), ['x.polygon.example']),
    ).toBe(false);
    expect(
      hostAllowed(new URL('https://x.polygon.example:8443/a'), [
        'x.polygon.example',
      ]),
    ).toBe(false);
    const b64 = Buffer.from('u:pass-1234').toString('base64');
    expect(scrubSecret(`a u:pass-1234 b ${b64}`, 'u:pass-1234')).not.toMatch(
      /pass-1234|dTpw/,
    );
    expect(PUBLIC_TEST_IP).toBeTruthy();
  });

  it('аудит Э7: эхо секрета в JSON-экранированном, base64url, URL-виде и одного пароля Basic — вырезается', () => {
    const secret = 'tok"en\\/+?=ÿ-Zq9x';
    const body = JSON.stringify({
      a: secret,
      b: Buffer.from(secret).toString('base64url'),
      c: Buffer.from(secret).toString('base64').replace(/=+$/, ''),
      d: encodeURIComponent(secret),
    });
    const out = scrubSecret(body, secret);
    expect(out).not.toContain(JSON.stringify(secret).slice(1, -1));
    expect(out).not.toContain(Buffer.from(secret).toString('base64url'));
    expect(out).not.toContain(encodeURIComponent(secret));
    expect(out.match(/\[секрет скрыт\]/g)).toHaveLength(4);
    // Basic «логин:пароль»: API вернул только пароль.
    const basic = 'api-user:Pa55-word-77';
    expect(
      scrubSecret(JSON.stringify({ echo: 'Pa55-word-77' }), basic),
    ).not.toContain('Pa55-word-77');
    // Короткий пароль (< 6) отдельно не вырезается — не крошит данные.
    expect(scrubSecret('{"n":"abc"}', 'user:abc')).toBe('{"n":"abc"}');
  });

  it('аудит Э7: служебные имена заголовка ключа запрещены', () => {
    for (const n of [
      'Host',
      'content-length',
      'Transfer-Encoding',
      'Proxy-Authorization',
      'x-v4c-actor',
      'accept-encoding',
      // аудит Э8: заголовки изменяющего запроса
      'Idempotency-Key',
      'X-V4C-Signature',
    ]) {
      expect(authHeaderNameAllowed(n)).toBe(false);
    }
    for (const n of ['X-Api-Key', 'authorization', 'x-shop-token']) {
      expect(authHeaderNameAllowed(n)).toBe(true);
    }
  });
});
