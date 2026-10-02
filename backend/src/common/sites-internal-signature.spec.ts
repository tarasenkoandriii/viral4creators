import {
  SITES_CALLER_TUTORIAL,
  SITES_HMAC_HEADERS,
  SITES_HMAC_WINDOW_SEC,
  canonicalString,
  isUsableSitesSecret,
  sitesSignatureHeaders,
  verifySitesRequest,
} from './sites-internal-signature';

const SECRET = 'x'.repeat(40);
const NOW = 1_790_000_000;
const base = {
  caller: SITES_CALLER_TUTORIAL,
  method: 'POST',
  path: '/internal/sites/tutorial/host-status',
  body: '{"telegramId":"42","url":"https://shop.example.com"}',
  unixSeconds: NOW,
  requestId: '0b8f3f0e-4a8b-4a52-9d55-2c6a1f9e0c11',
};

function verify(
  overrides: Partial<{
    method: string;
    path: string;
    body: string;
    headers: Record<string, string>;
    now: number;
    secret: string;
    expectedCaller: string;
  }> = {},
) {
  const headers = overrides.headers ?? sitesSignatureHeaders(SECRET, base);
  return verifySitesRequest(overrides.secret ?? SECRET, {
    method: overrides.method ?? base.method,
    path: overrides.path ?? base.path,
    body: overrides.body ?? base.body,
    headers,
    nowSeconds: overrides.now ?? NOW,
    expectedCaller: overrides.expectedCaller ?? SITES_CALLER_TUTORIAL,
  });
}

describe('sites-internal-signature (П-С3)', () => {
  it('подписанный запрос проходит и отдаёт id запроса', () => {
    expect(verify()).toEqual({
      ok: true,
      requestId: base.requestId,
      caller: SITES_CALLER_TUTORIAL,
      unixSeconds: NOW,
    });
  });

  it('каноническая строка: схема, вызывающий, метод, путь, метка, id, хеш тела', () => {
    const lines = canonicalString({ ...base, method: 'post' }).split('\n');
    expect(lines.slice(0, 6)).toEqual([
      'SITES-HMAC-V1',
      SITES_CALLER_TUTORIAL,
      'POST',
      base.path,
      String(NOW),
      base.requestId,
    ]);
    expect(lines[6]).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ['тело', { body: base.body.replace('42', '43') }],
    ['путь', { path: '/internal/sites/tutorial/register-host' }],
    ['метод', { method: 'PUT' }],
    ['секрет', { secret: 'y'.repeat(40) }],
  ])('подмена: %s → mismatch', (_n, o) => {
    expect(verify(o)).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('подмена id запроса в заголовке (для обхода таблицы повторов) → mismatch', () => {
    const headers = {
      ...sitesSignatureHeaders(SECRET, base),
      [SITES_HMAC_HEADERS.requestId]: 'ffffffff-4a8b-4a52-9d55-2c6a1f9e0c11',
    };
    expect(verify({ headers })).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('подмена метки времени внутри окна → mismatch', () => {
    const headers = {
      ...sitesSignatureHeaders(SECRET, base),
      [SITES_HMAC_HEADERS.timestamp]: String(NOW + 10),
    };
    expect(verify({ headers })).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('окно ±5 мин: на границе — ok, за ней — stale (в обе стороны)', () => {
    expect(verify({ now: NOW + SITES_HMAC_WINDOW_SEC }).ok).toBe(true);
    expect(verify({ now: NOW - SITES_HMAC_WINDOW_SEC }).ok).toBe(true);
    expect(verify({ now: NOW + SITES_HMAC_WINDOW_SEC + 1 })).toEqual({
      ok: false,
      reason: 'stale',
    });
    expect(verify({ now: NOW - SITES_HMAC_WINDOW_SEC - 1 })).toEqual({
      ok: false,
      reason: 'stale',
    });
  });

  it('чужой вызывающий → caller (подпись другого направления не подходит)', () => {
    expect(verify({ expectedCaller: 'generator-admin' })).toEqual({
      ok: false,
      reason: 'caller',
    });
  });

  it('нет заголовка → missing; кривой формат → malformed', () => {
    const h = sitesSignatureHeaders(SECRET, base);
    const without = { ...h };
    delete without[SITES_HMAC_HEADERS.signature];
    expect(verify({ headers: without })).toEqual({
      ok: false,
      reason: 'missing',
    });
    expect(
      verify({ headers: { ...h, [SITES_HMAC_HEADERS.signature]: 'v1=zz' } }),
    ).toEqual({ ok: false, reason: 'malformed' });
    expect(
      verify({ headers: { ...h, [SITES_HMAC_HEADERS.requestId]: 'short' } }),
    ).toEqual({ ok: false, reason: 'malformed' });
    expect(verify({ path: '/x?y=1' })).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('секрет короче 32 символов не годится', () => {
    expect(isUsableSitesSecret('a'.repeat(31))).toBe(false);
    expect(isUsableSitesSecret(' '.repeat(40))).toBe(false);
    expect(isUsableSitesSecret(undefined)).toBe(false);
    expect(isUsableSitesSecret('a'.repeat(32))).toBe(true);
  });
});
