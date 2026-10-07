import { siteDailyCapFromPlan } from './plans';
import {
  GRACE_MS,
  INTERNAL_PLAN_ID,
  INTERNAL_UNITS_LIMIT,
  applyPaidPeriod,
  internalSiteIds,
  internalSubscriptionState,
  subscriptionState,
  unitsLimit,
  type SubscriptionRow,
} from './subscription-state';

const DAY = 86_400_000;
const T0 = new Date('2026-10-01T00:00:00Z');
const at = (days: number) => new Date(T0.getTime() + days * DAY);

function row(over: Partial<SubscriptionRow> = {}): SubscriptionRow {
  return {
    planId: 'start',
    status: 'active',
    method: 'wayforpay',
    anchorAt: T0,
    paidThrough: at(30),
    cancelAtPeriodEnd: false,
    autoTopUp: false,
    autoTopUpCapMicroUsd: 0,
    ...over,
  };
}

describe('тариф кабинета и период учёта', () => {
  it('нет строки и нет сайтов — пробный не начат, лимит 0', () => {
    const s = subscriptionState(null, null, T0);
    expect(s).toMatchObject({ planId: null, status: 'none', periodKey: null });
    expect(unitsLimit(s, 0)).toBe(0);
  });

  it('нет строки — пробный 14 дней от первого сайта; после — истёк', () => {
    const s = subscriptionState(null, T0, at(13.9));
    expect(s).toMatchObject({
      planId: 'trial',
      status: 'trial',
      periodKey: T0.toISOString(),
    });
    expect(s.periodEnd).toEqual(at(14));
    expect(unitsLimit(s, 0)).toBe(50);
    expect(subscriptionState(null, T0, at(14))).toMatchObject({
      planId: null,
      status: 'expired',
    });
  });

  it('периоды по 30 дней от якоря: новый период — новый ключ счётчика', () => {
    const r = row({ paidThrough: at(90) });
    const p1 = subscriptionState(r, null, at(5));
    const p2 = subscriptionState(r, null, at(35));
    expect(p1.periodKey).toBe(T0.toISOString());
    expect(p2.periodKey).toBe(at(30).toISOString());
    expect(p2.periodEnd).toEqual(at(60));
    expect(unitsLimit(p2, 100)).toBe(500);
  });

  it('после оплаченного — льгота 3 дня для автопродления; период НЕ обновляется; затем истёк', () => {
    const r = row();
    const g = subscriptionState(r, null, at(31));
    expect(g).toMatchObject({
      planId: 'start',
      status: 'grace',
      periodKey: T0.toISOString(),
    });
    expect(
      subscriptionState(r, null, new Date(at(30).getTime() + GRACE_MS)),
    ).toMatchObject({
      planId: null,
      status: 'expired',
    });
  });

  it('отмена продления или ручной тариф — без льготы', () => {
    expect(
      subscriptionState(row({ cancelAtPeriodEnd: true }), null, at(30.1))
        .planId,
    ).toBeNull();
    expect(
      subscriptionState(row({ method: 'manual' }), null, at(30.1)).planId,
    ).toBeNull();
    expect(
      subscriptionState(row({ status: 'expired' }), null, at(1)).planId,
    ).toBeNull();
  });

  it('оплата того же тарифа в срок/льготу — +30 дней к paidThrough, якорь тот же', () => {
    const r = row();
    expect(applyPaidPeriod(r, 'start', at(29))).toEqual({
      anchorAt: T0,
      paidThrough: at(60),
      planChanged: false,
    });
    expect(applyPaidPeriod(r, 'start', at(31)).paidThrough).toEqual(at(60));
  });

  it('другой тариф, истёкшая подписка или пробный — новый якорь «сейчас»', () => {
    const now = at(10);
    expect(applyPaidPeriod(row(), 'business', now)).toEqual({
      anchorAt: now,
      paidThrough: at(40),
      planChanged: true,
    });
    expect(applyPaidPeriod(row(), 'start', at(40)).anchorAt).toEqual(at(40));
    expect(applyPaidPeriod(null, 'pro', now).planChanged).toBe(true);
    expect(
      applyPaidPeriod(
        row({ planId: 'trial', method: 'trial', paidThrough: at(14) }),
        'start',
        now,
      ).anchorAt,
    ).toEqual(now);
  });
});

describe('внутренний тенант (Ш5 (4) / Ш6 (8))', () => {
  it('ASSIST_INTERNAL_SITE_IDS: запятые/пробелы, дубли, мусор отбрасывается; пусто — []', () => {
    expect(internalSiteIds({})).toEqual([]);
    expect(internalSiteIds({ ASSIST_INTERNAL_SITE_IDS: '  ' })).toEqual([]);
    expect(
      internalSiteIds({
        ASSIST_INTERNAL_SITE_IDS: "cmabc123, site_2 cmabc123,,\n x'; DROP",
      }),
    ).toEqual(['cmabc123', 'site_2', 'DROP']);
    expect(
      internalSiteIds({ ASSIST_INTERNAL_SITE_IDS: 'a'.repeat(65) }),
    ).toEqual([]);
  });

  it('бессрочный тариф pro, периоды по 30 дней от якоря, без продления, оплаты и автодокупки', () => {
    const s = internalSubscriptionState(T0, at(65));
    expect(s).toMatchObject({
      planId: INTERNAL_PLAN_ID,
      status: 'active',
      method: 'internal',
      internal: true,
      renews: false,
      autoTopUp: false,
      periodKey: at(60).toISOString(),
    });
    expect(s.periodEnd).toEqual(at(90));
    // Без якоря — фиксированная эпоха, период детерминирован.
    const e = internalSubscriptionState(null, at(1));
    expect(e.periodKey).toBe(
      internalSubscriptionState(null, at(1.5)).periodKey,
    );
    // Время до якоря (часы) — нулевой период, не отрицательный.
    expect(internalSubscriptionState(at(5), at(1)).periodKey).toBe(
      at(5).toISOString(),
    );
  });

  it('лимит единиц не достигается, а денежный потолок сайта — как у тарифа (не 0 и не бесконечность)', () => {
    const s = internalSubscriptionState(T0, at(1));
    expect(unitsLimit(s, 0)).toBe(INTERNAL_UNITS_LIMIT);
    expect(unitsLimit({ ...s, internal: undefined }, 0)).toBe(3000);
    const cap = siteDailyCapFromPlan(s.planId);
    expect(cap).toBeGreaterThan(0);
    expect(Number.isFinite(cap)).toBe(true);
  });
});
