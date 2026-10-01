/**
 * visitor-token (ТЗ §4.13 п.2): подпись HMAC-SHA256, строгая схема, срок.
 * Чистый модуль — без базы.
 */
import { createHmac } from 'crypto';
import {
  inspectVisitorToken,
  signVisitorToken,
  verifyVisitorToken,
  type VisitorTokenPayload,
} from './visitor-token';

const KEY = Buffer.from('k'.repeat(32));
const NOW = new Date('2026-10-01T12:00:00Z');
const iat = Math.floor(NOW.getTime() / 1000);

function payload(over: Partial<VisitorTokenPayload> = {}): VisitorTokenPayload {
  return {
    v: 1,
    siteId: 'site1',
    visitorId: 'v_abc',
    parentOrigin: 'https://shop.example.com',
    ipHash: 'a'.repeat(64),
    preview: false,
    iat,
    exp: iat + 24 * 3600,
    ...over,
  };
}

/** Подписать произвольное тело тем же ключом (проверка схемы, а не подписи). */
function forge(body: unknown, key = KEY): string {
  const b = Buffer.from(JSON.stringify(body)).toString('base64url');
  return `${b}.${createHmac('sha256', key).update(b).digest('base64url')}`;
}

describe('visitor-token', () => {
  it('подписанный токен разбирается в тот же payload', () => {
    const t = signVisitorToken(payload(), KEY);
    expect(verifyVisitorToken(t, KEY, NOW)).toEqual(payload());
    expect(t).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it('другой ключ, правка тела или подписи — null (invalid)', () => {
    const t = signVisitorToken(payload(), KEY);
    expect(verifyVisitorToken(t, Buffer.from('x'.repeat(32)), NOW)).toBeNull();
    const [body, sig] = t.split('.');
    const other = Buffer.from(
      JSON.stringify({ ...payload(), siteId: 'site2' }),
    ).toString('base64url');
    expect(verifyVisitorToken(`${other}.${sig}`, KEY, NOW)).toBeNull();
    expect(
      verifyVisitorToken(`${body}.${sig.slice(0, -2)}AA`, KEY, NOW),
    ).toBeNull();
    expect(inspectVisitorToken(`${body}.${sig}.x`, KEY, NOW).status).toBe(
      'invalid',
    );
    expect(inspectVisitorToken(undefined, KEY, NOW).status).toBe('invalid');
    expect(inspectVisitorToken('x'.repeat(5000), KEY, NOW).status).toBe(
      'invalid',
    );
  });

  it('срок: истёк — expired (отличимо от invalid); выдан в будущем > 60 с — invalid', () => {
    const t = signVisitorToken(payload({ exp: iat + 10 }), KEY);
    expect(
      inspectVisitorToken(t, KEY, new Date(NOW.getTime() + 10_000)).status,
    ).toBe('expired');
    expect(
      verifyVisitorToken(t, KEY, new Date(NOW.getTime() + 10_000)),
    ).toBeNull();
    const future = signVisitorToken(
      payload({ iat: iat + 120, exp: iat + 999 }),
      KEY,
    );
    expect(inspectVisitorToken(future, KEY, NOW).status).toBe('invalid');
  });

  it('схема строгая: лишнее/недостающее поле, чужая версия, тип — invalid даже с верной подписью', () => {
    expect(inspectVisitorToken(forge(payload()), KEY, NOW).status).toBe('ok');
    expect(
      inspectVisitorToken(forge({ ...payload(), admin: true }), KEY, NOW)
        .status,
    ).toBe('invalid');
    const { ipHash: _x, ...noIp } = payload();
    expect(inspectVisitorToken(forge(noIp), KEY, NOW).status).toBe('invalid');
    expect(
      inspectVisitorToken(forge({ ...payload(), v: 2 }), KEY, NOW).status,
    ).toBe('invalid');
    expect(
      inspectVisitorToken(forge({ ...payload(), preview: 'true' }), KEY, NOW)
        .status,
    ).toBe('invalid');
    expect(
      inspectVisitorToken(forge({ ...payload(), exp: iat + 0.5 }), KEY, NOW)
        .status,
    ).toBe('invalid');
  });
});
