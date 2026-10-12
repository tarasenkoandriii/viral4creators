/**
 * Заход 13 (Р-З13-Г1): причины оборванной записи — один список у воркера и
 * у sites-backend (протокол очереди), счётчик стража → `blockedWrites`.
 */
import {
  BLOCKED_WRITES_MAX,
  WRITE_BLOCK_REASONS,
  blockedWritesOf,
  hopHeaders,
} from '../../src/browser/context';
import { WRITE_REFUSALS } from '../../src/safety/write-guard';
import {
  WRITE_BLOCK_REASONS as PROTOCOL_REASONS,
  parseJobResult,
} from '../../src/shared/browser-job-protocol';

describe('blockedWrites: причины и итог', () => {
  it('список причин — из протокола: причины стража + websocket + popup', () => {
    expect(WRITE_BLOCK_REASONS).toBe(PROTOCOL_REASONS);
    expect([...WRITE_BLOCK_REASONS]).toEqual([
      ...WRITE_REFUSALS,
      'websocket',
      'popup',
    ]);
  });

  it('только ненулевые причины, итог — их сумма', () => {
    expect(
      blockedWritesOf({
        method: 3,
        graphql: 0,
        logout: 1,
        danger: 0,
        passive: 0,
        websocket: 2,
        popup: 0,
      }),
    ).toEqual({ total: 6, reasons: { method: 3, logout: 1, websocket: 2 } });
    expect(
      blockedWritesOf({
        method: 0,
        graphql: 0,
        logout: 0,
        danger: 0,
        passive: 0,
        websocket: 0,
        popup: 0,
      }),
    ).toEqual({ total: 0, reasons: {} });
  });

  it('аудит P3-6: счётчик больше 1e6 усекается, сумма = итог, самопроверка протокола проходит', () => {
    const bw = blockedWritesOf({
      method: 900_000,
      graphql: 0,
      logout: 0,
      danger: 300_000,
      passive: 5,
      websocket: 2e9,
      popup: 1,
    });
    expect(bw.total).toBe(BLOCKED_WRITES_MAX);
    expect(bw.reasons).toEqual({ method: 900_000, danger: 100_000 });
    expect(() =>
      parseJobResult(
        'admin-crawl',
        {
          startUrl: 'https://a.test/',
          allowedHosts: ['a.test'],
          viewport: 'desktop',
          maxPages: 1,
          maxDepth: 0,
          loginMethod: 'password',
        },
        {
          loggedIn: true,
          pages: [],
          refusedClicks: 0,
          skippedLinks: 0,
          blockedWrites: bw,
        },
      ),
    ).not.toThrow();
  });
});

describe('hopHeaders: заголовки шага редиректа (заход 13, аудит P1-1)', () => {
  const h = {
    Cookie: 'sid=SECRET',
    authorization: 'Bearer T',
    'proxy-authorization': 'Basic P',
    'x-csrf-token': 'C',
    'X-Requested-With': 'XMLHttpRequest',
    accept: 'application/json',
    'accept-encoding': 'gzip, br',
    referer: 'https://a.test/x',
  };

  it('тот же origin: без cookie и сжатия, авторизация и x-* остаются', () => {
    expect(hopHeaders(h, false)).toEqual({
      authorization: 'Bearer T',
      'proxy-authorization': 'Basic P',
      'x-csrf-token': 'C',
      'x-requested-with': 'XMLHttpRequest',
      accept: 'application/json',
      referer: 'https://a.test/x',
      'accept-encoding': 'identity',
    });
  });

  it('смена origin: ещё и без authorization, proxy-authorization и x-*', () => {
    expect(hopHeaders(h, true)).toEqual({
      accept: 'application/json',
      referer: 'https://a.test/x',
      'accept-encoding': 'identity',
    });
  });
});
