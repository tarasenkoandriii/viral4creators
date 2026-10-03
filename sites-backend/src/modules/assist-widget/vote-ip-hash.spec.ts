/**
 * Хеш IP журнала карты (аудит Ш4): соль — окно устаревания (неделя), а не
 * сутки — «разные IP за 7 дней» не обходится сменой суток; сырого IP в
 * хеше не видно, сайты и окна не сопоставимы.
 */
import { UI_MAP_STALE } from '../site-core/ui-map/ui-map-model';
import { uiVoteIpHash, voteWindow, windowIpHash } from './vote-ip-hash';

describe('windowIpHash — соль на окно', () => {
  const W = UI_MAP_STALE.windowMs;
  const start = new Date(2000 * W + 3600_000);
  const day = 86_400_000;

  it('внутри окна один адрес — один хеш (разные сутки); следующее окно — другой', () => {
    const a = windowIpHash('203.0.113.7', 'sec', 'salt', start);
    expect(
      windowIpHash('203.0.113.7', 'sec', 'salt', new Date(+start + day)),
    ).toBe(a);
    expect(
      windowIpHash('203.0.113.7', 'sec', 'salt', new Date(+start + 6 * day)),
    ).toBe(a);
    expect(
      windowIpHash('203.0.113.7', 'sec', 'salt', new Date(+start + W)),
    ).not.toBe(a);
    expect(voteWindow(new Date(+start + W))).toBe(voteWindow(start) + 1);
  });

  it('другой адрес, сайт или секрет — другой хеш; IPv6 — по /64; сырого IP нет', () => {
    const a = windowIpHash('203.0.113.7', 'sec', 'salt', start);
    expect(windowIpHash('203.0.113.8', 'sec', 'salt', start)).not.toBe(a);
    expect(windowIpHash('203.0.113.7', 'sec', 'other', start)).not.toBe(a);
    expect(windowIpHash('203.0.113.7', 'sec2', 'salt', start)).not.toBe(a);
    expect(windowIpHash('2001:db8:1:2::1', 'sec', null, start)).toBe(
      windowIpHash('2001:db8:1:2::ffff', 'sec', null, start),
    );
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toContain('203.0.113.7');
  });

  it('uiVoteIpHash: адрес запроса + секрет + соль сайта; адреса или секрета нет — суточный хеш токена', async () => {
    const db = {
      assistSite: { findUnique: async () => ({ ipSalt: 's' }) },
    } as never;
    const env = { ASSIST_SECRETS_KEY: 'k'.repeat(32) } as NodeJS.ProcessEnv;
    const req = { headers: { 'x-forwarded-for': '203.0.113.7' } };
    const h = await uiVoteIpHash(db, {
      siteId: 'x',
      req,
      fallback: 'daily',
      now: start,
      env,
    });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(
      await uiVoteIpHash(db, {
        siteId: 'x',
        req: { headers: { 'x-forwarded-for': '203.0.113.7' } },
        fallback: 'daily',
        now: new Date(+start + 2 * day),
        env,
      }),
    ).toBe(h);
    for (const p of [
      { req: { headers: {} }, env },
      { req, env: {} as NodeJS.ProcessEnv },
    ])
      expect(
        await uiVoteIpHash(db, {
          siteId: 'x',
          fallback: 'daily',
          now: start,
          ...p,
        }),
      ).toBe('daily');
  });
});
