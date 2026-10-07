/**
 * Лимиты приглашения и имя пригласившего — чистая логика (без Nest и
 * базы). По HTTP — site-core.http.spec.ts и acceptance/sh-audit.
 */
import { HttpException, HttpStatus } from '@nestjs/common';
import { inviterNameOf } from './account.service';
import {
  INVITE_ACCEPT_IP_LIMIT,
  INVITE_ACCEPT_LIMIT,
  INVITE_RATE_WINDOW_MS,
  InviteAcceptLimiter,
} from './invite-rate-limit';

function caught(fn: () => void): HttpException | null {
  try {
    fn();
    return null;
  } catch (e) {
    if (e instanceof HttpException) return e;
    throw e;
  }
}

describe('InviteAcceptLimiter', () => {
  it(`на человека: ${INVITE_ACCEPT_LIMIT} в окно, дальше 429 с retryAfterMs; другой человек не задет`, () => {
    const l = new InviteAcceptLimiter();
    const t0 = 1_000_000;
    for (let i = 0; i < INVITE_ACCEPT_LIMIT; i++) {
      expect(caught(() => l.check(1n, `10.0.0.${i}`, t0))).toBeNull();
    }
    const e = caught(() => l.check(1n, '10.0.1.1', t0 + 1000));
    expect(e?.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(e?.getResponse()).toMatchObject({
      code: 'RATE_LIMIT_EXCEEDED',
      retryAfterMs: INVITE_RATE_WINDOW_MS - 1000,
    });
    expect(caught(() => l.check(2n, '10.0.1.2', t0 + 1000))).toBeNull();
    // Окно прошло — снова можно.
    expect(
      caught(() => l.check(1n, '10.0.1.3', t0 + INVITE_RATE_WINDOW_MS)),
    ).toBeNull();
  });

  it(`на адрес: ${INVITE_ACCEPT_IP_LIMIT} в окно с одного IP разными людьми, дальше 429; другой IP не задет`, () => {
    expect(INVITE_ACCEPT_IP_LIMIT).toBeGreaterThan(INVITE_ACCEPT_LIMIT);
    const l = new InviteAcceptLimiter();
    const t0 = 5_000_000;
    for (let i = 0; i < INVITE_ACCEPT_IP_LIMIT; i++) {
      expect(
        caught(() => l.check(BigInt(100 + i), '203.0.113.7', t0)),
      ).toBeNull();
    }
    const e = caught(() => l.check(99_999n, '203.0.113.7', t0));
    expect(e?.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(caught(() => l.check(99_999n, '203.0.113.8', t0))).toBeNull();
  });
});

describe('inviterNameOf', () => {
  it('берёт username и имя, обрезает пробелы и длину', () => {
    expect(inviterNameOf({ username: ' olga ', firstName: 'Ольга' })).toEqual({
      username: 'olga',
      firstName: 'Ольга',
    });
    expect(
      inviterNameOf({ username: null, firstName: 'Я'.repeat(200) })?.firstName,
    ).toHaveLength(64);
  });

  it('ни username, ни имени (или не строки) — null', () => {
    expect(inviterNameOf({ username: null, firstName: '  ' })).toBeNull();
    expect(inviterNameOf({ username: 42, firstName: {} })).toBeNull();
    expect(inviterNameOf(null)).toBeNull();
    expect(inviterNameOf({ username: 'only_user' })).toEqual({
      username: 'only_user',
      firstName: null,
    });
  });
});
