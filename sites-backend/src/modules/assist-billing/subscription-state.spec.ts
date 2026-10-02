import {
  GRACE_MS,
  applyPaidPeriod,
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
