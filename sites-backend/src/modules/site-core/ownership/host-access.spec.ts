import { HttpException } from '@nestjs/common';
import { FakeStore } from '../testing/fake-sites-db.testing';
import { HostAccessRow, HostPurpose, evaluateHostAccess } from './host-access';
import { HostAccessService } from './host-access.service';

const H = 60 * 60 * 1000;
const DAY = 24 * H;
const NOW = new Date('2026-10-01T12:00:00Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const ahead = (ms: number) => new Date(NOW.getTime() + ms);

function row(over: Partial<HostAccessRow>): HostAccessRow {
  return {
    id: 'h1',
    accountId: 'A',
    host: 'example.com',
    status: 'verified',
    expiresAt: ahead(30 * DAY),
    revokedAt: null,
    reverifyBlockedAt: null,
    ...over,
  };
}

const NON_WIDGET: HostPurpose[] = [
  'assist-crawl',
  'assist-admin',
  'qa-l1',
  'qa-l2',
  'qa-l3',
  'qa-history',
];

describe('evaluateHostAccess — уровни и льгота', () => {
  it('verified, не истёк — L1 для всех назначений', () => {
    for (const p of [...NON_WIDGET, 'assist-widget'] as HostPurpose[]) {
      expect(evaluateHostAccess(row({}), p, NOW)).toEqual({
        ok: true,
        level: 'L1',
        grace: false,
      });
    }
  });

  describe('хост, отозванный 2 ч назад', () => {
    const revoked = row({ status: 'revoked', revokedAt: ago(2 * H) });

    it("'assist-widget' — пропускает (льгота 72 ч)", () => {
      expect(evaluateHostAccess(revoked, 'assist-widget', NOW)).toEqual({
        ok: true,
        level: 'L1',
        grace: true,
        graceUntil: ahead(70 * H),
      });
    });

    it.each(NON_WIDGET)("'%s' — нет", (p) => {
      expect(evaluateHostAccess(revoked, p, NOW)).toEqual({
        ok: false,
        reason: 'revoked',
      });
    });
  });

  it('льгота кончается ровно через 72 ч', () => {
    const r = row({ status: 'revoked', revokedAt: ago(72 * H) });
    expect(evaluateHostAccess(r, 'assist-widget', NOW).ok).toBe(false);
    const r2 = row({ status: 'revoked', revokedAt: ago(72 * H - 1) });
    expect(evaluateHostAccess(r2, 'assist-widget', NOW).ok).toBe(true);
  });

  it('expired: льгота от expiresAt и только для виджета', () => {
    const e = row({ status: 'expired', expiresAt: ago(10 * H) });
    expect(evaluateHostAccess(e, 'assist-widget', NOW)).toMatchObject({
      ok: true,
      grace: true,
    });
    expect(evaluateHostAccess(e, 'assist-crawl', NOW)).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('verified с наступившим expiresAt — уже expired (не ждём крон)', () => {
    const v = row({ status: 'verified', expiresAt: ago(1) });
    expect(evaluateHostAccess(v, 'qa-l1', NOW)).toEqual({
      ok: false,
      reason: 'expired',
    });
    expect(evaluateHostAccess(v, 'assist-widget', NOW)).toMatchObject({
      ok: true,
      grace: true,
    });
  });

  it('отзыв другим кабинетом (блокировка) — без льготы даже виджету', () => {
    const r = row({
      status: 'revoked',
      revokedAt: ago(H),
      reverifyBlockedAt: ago(H),
    });
    expect(evaluateHostAccess(r, 'assist-widget', NOW).ok).toBe(false);
  });

  it('verified с блокировкой (след гонки отзыва) — закрыт для всех L1, песочница — можно', () => {
    // Аудит Э0: блокировка сильнее статуса — иначе строка, которую
    // проверка выдворенного кабинета успела перевести в `verified`, снова
    // открывала бы ему обход, «Админку» и QA.
    const v = row({ status: 'verified', reverifyBlockedAt: ago(H) });
    for (const p of [...NON_WIDGET, 'assist-widget'] as HostPurpose[]) {
      expect(evaluateHostAccess(v, p, NOW)).toEqual({
        ok: false,
        reason: 'revoked',
      });
    }
    expect(evaluateHostAccess(v, 'assist-sandbox', NOW).ok).toBe(true);
  });

  it('pending — не подтверждён ни для кого, песочница (L0) — можно', () => {
    const p = row({ status: 'pending', expiresAt: null });
    expect(evaluateHostAccess(p, 'assist-widget', NOW)).toEqual({
      ok: false,
      reason: 'not_verified',
    });
    expect(evaluateHostAccess(p, 'assist-sandbox', NOW)).toEqual({
      ok: true,
      level: 'L0',
      grace: false,
    });
  });

  it('неизвестный статус и опечатка в назначении — закрыто', () => {
    expect(
      evaluateHostAccess(row({ status: 'VERIFIED' }), 'assist-crawl', NOW).ok,
    ).toBe(false);
    expect(() =>
      evaluateHostAccess(row({}), 'assist-widgt' as HostPurpose, NOW),
    ).toThrow(/неизвестное/);
  });
});

describe('HostAccessService.assertHostVerified', () => {
  function setup() {
    const store = new FakeStore();
    store.insert('SiteAccount', { id: 'A', verifyToken: 'tA' });
    store.insert('SiteAccount', { id: 'B', verifyToken: 'tB' });
    store.insert('Site', { id: 's1', accountId: 'A', name: 'X' });
    store.insert('SiteHost', {
      id: 'h1',
      accountId: 'A',
      siteId: 's1',
      host: 'example.com',
      status: 'revoked',
      revokedAt: ago(2 * H),
      expiresAt: ahead(DAY),
    });
    return { store, svc: new HostAccessService(store.sitesDb()) };
  }

  it('2 ч после отзыва: assist-widget — да, assist-crawl и qa-* — 403', async () => {
    const { svc } = setup();
    await expect(
      svc.assertHostVerified('h1', 'assist-widget', { now: NOW }),
    ).resolves.toMatchObject({ decision: { ok: true, grace: true } });
    for (const p of ['assist-crawl', 'qa-l1', 'qa-l2'] as HostPurpose[]) {
      await expect(
        svc.assertHostVerified('h1', p, { now: NOW }),
      ).rejects.toBeInstanceOf(HttpException);
    }
  });

  it('хост другого кабинета через accountId — «не найден»', async () => {
    const { svc } = setup();
    await expect(
      svc.assertHostVerified('h1', 'assist-widget', {
        accountId: 'B',
        now: NOW,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('opt-out домена закрывает даже песочницу', async () => {
    const { store, svc } = setup();
    store.insert('SiteOptOutDomain', {
      domain: 'example.com',
      source: 'email',
    });
    await expect(
      svc.assertHostVerified('h1', 'assist-sandbox', { now: NOW }),
    ).rejects.toMatchObject({ status: 403 });
  });
});
