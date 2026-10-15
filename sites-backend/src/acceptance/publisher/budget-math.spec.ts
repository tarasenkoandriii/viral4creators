/**
 * Бюджет как чистые функции (P-C, проектный документ §9.2; ТЗ §17):
 * [AT-F12-01] вектор §17, [AT-CORE-17] отмена/возврат, 80 %/100 %,
 * delivered_unpaid ⊆ open, перевод резерва, кассовое vs экономическое
 * (AI-07), статус оплаты (§6.4, аудит P3-8).
 */
import {
  budgetSnapshot,
  canReserve,
  cashVsEconomic,
  deliveredUnpaid,
  expectedCounters,
  expensesFromEntries,
  openCommitment,
  paymentStatusOf,
  type BudgetLimitInput,
  type ExpenseAmounts,
} from '../../modules/publisher/distribution/budget-math';

const K = (uah: number): bigint => BigInt(uah * 100);
const limit = (over: Partial<BudgetLimitInput> = {}): BudgetLimitInput => ({
  total: K(10_000),
  protectedReserve: K(2_000),
  byCategory: { placements: K(6_000), tools: K(2_000) },
  perPurchaseMax: K(2_000),
  warnRatioBp: 8000,
  ...over,
});
const exp = (over: Partial<ExpenseAmounts>): ExpenseAmounts => ({
  amountTotal: 0n,
  paid: 0n,
  refunded: 0n,
  cancelled: 0n,
  delivered: 0n,
  category: 'placements',
  ...over,
});

describe('[AT-F12-01] вектор ТЗ §17 (budget-math)', () => {
  // net_paid 2 000 (оплачено), open 1 000 (из них оказано 400), резерв 2 000.
  const paid = exp({
    amountTotal: K(2_000),
    paid: K(2_000),
    delivered: K(2_000),
  });
  const open = exp({
    amountTotal: K(1_000),
    delivered: K(400),
    category: 'tools',
  });

  it('10 000 − 2 000 − 1 000 − 2 000 = 5 000; delivered_unpaid 400 внутри open и не вычитается второй раз', () => {
    const s = budgetSnapshot(limit(), [paid, open]);
    expect(s.netPaid).toBe(K(2_000));
    expect(s.openCommitment).toBe(K(1_000));
    expect(s.deliveredUnpaid).toBe(K(400));
    expect(s.available).toBe(K(5_000));
    expect(deliveredUnpaid(open) <= openCommitment(open)).toBe(true);
  });

  it('оплата обязательства 1 000 сохраняет 5 000 (перенос open → net_paid)', () => {
    const s = budgetSnapshot(limit(), [paid, { ...open, paid: K(1_000) }]);
    expect(s.netPaid).toBe(K(3_000));
    expect(s.openCommitment).toBe(0n);
    expect(s.available).toBe(K(5_000));
  });

  it('перевод 500 из резерва в placements → 5 500, общий лимит 10 000', () => {
    const s = budgetSnapshot(
      limit({
        protectedReserve: K(1_500),
        byCategory: { placements: K(6_500), tools: K(2_000) },
      }),
      [paid, open],
    );
    expect(s.available).toBe(K(5_500));
    expect(s.total).toBe(K(10_000));
    expect(s.byCategory.placements.limit).toBe(K(6_500));
  });

  it('категория other — в лимите tools', () => {
    const s = budgetSnapshot(limit(), [
      exp({ amountTotal: K(300), category: 'other' }),
    ]);
    expect(s.byCategory.tools.used).toBe(K(300));
    expect(s.byCategory.placements.used).toBe(0n);
  });

  it('80 % — предупреждение, 100 % — стоп новых обязательств (база — лимит минус резерв)', () => {
    const at = (uah: number) =>
      budgetSnapshot(limit(), [exp({ amountTotal: K(uah), paid: K(uah) })]);
    expect(at(6_399).warn).toBe(false);
    expect(at(6_400)).toMatchObject({
      warn: true,
      stopped: false,
      usageBp: 8000,
    });
    expect(at(8_000)).toMatchObject({
      warn: true,
      stopped: true,
      usageBp: 10000,
    });
    expect(canReserve(at(8_000), 1n, 'tools')).toEqual({
      ok: false,
      reason: 'stopped',
    });
  });

  it('canReserve: остаток, категория, предел одной закупки', () => {
    const s = budgetSnapshot(limit(), [paid, open]);
    expect(canReserve(s, K(2_000), 'placements')).toEqual({ ok: true });
    expect(canReserve(s, K(2_001), 'placements')).toEqual({
      ok: false,
      reason: 'per_purchase_cap',
    });
    expect(canReserve(s, K(1_500), 'tools')).toEqual({
      ok: false,
      reason: 'category_cap',
    });
    const tight = budgetSnapshot(limit({ perPurchaseMax: K(9_000) }), [
      paid,
      open,
    ]);
    expect(canReserve(tight, K(5_001), 'placements')).toEqual({
      ok: false,
      reason: 'insufficient',
    });
  });

  it('canReserve: perPurchaseMax = 0 — закупки отключены (purchases_disabled), инструменты — как прежде', () => {
    const off = budgetSnapshot(limit({ perPurchaseMax: 0n }), [paid, open]);
    for (const amount of [1n, K(100), K(9_000)])
      expect(canReserve(off, amount, 'placements')).toEqual({
        ok: false,
        reason: 'purchases_disabled',
      });
    expect(canReserve(off, K(500), 'tools')).toEqual({ ok: true });
    expect(canReserve(off, K(500), 'other')).toEqual({ ok: true });
    // ненулевой предел — прежние причины
    const s = budgetSnapshot(limit({ perPurchaseMax: 1n }), [paid, open]);
    expect(canReserve(s, 2n, 'placements')).toEqual({
      ok: false,
      reason: 'per_purchase_cap',
    });
    expect(canReserve(s, 1n, 'placements')).toEqual({ ok: true });
  });
});

describe('[AT-CORE-17] отмена и возврат (budget-math)', () => {
  it('отмена освобождает только подтверждённую часть', () => {
    const e = exp({ amountTotal: K(1_500), cancelled: K(1_000) });
    const s = budgetSnapshot(limit(), [e]);
    expect(s.openCommitment).toBe(K(500));
    expect(s.available).toBe(K(7_500));
  });

  it('обещанный возврат (не подтверждён) не меняет net_paid; подтверждённый — меняет', () => {
    const paidE = exp({ amountTotal: K(1_000), paid: K(1_000) });
    expect(budgetSnapshot(limit(), [paidE]).netPaid).toBe(K(1_000));
    // Обещание — запись refund `pending`: подтверждённых возвратов 0.
    const heads = [{ id: 'e1', category: 'placements' as const }];
    const entries = [
      {
        expenseId: 'e1',
        kind: 'commit' as const,
        amount: K(1_000),
        status: 'confirmed' as const,
        confirmedAt: new Date(),
      },
      {
        expenseId: 'e1',
        kind: 'pay' as const,
        amount: K(1_000),
        status: 'confirmed' as const,
        confirmedAt: new Date(),
      },
      {
        expenseId: 'e1',
        kind: 'refund' as const,
        amount: K(1_000),
        status: 'pending' as const,
        confirmedAt: null,
      },
    ];
    const promised = [...expensesFromEntries(heads, entries).values()];
    expect(budgetSnapshot(limit(), promised).netPaid).toBe(K(1_000));
    const confirmed = [
      ...expensesFromEntries(heads, [
        ...entries.slice(0, 2),
        {
          ...entries[2],
          status: 'confirmed' as const,
          confirmedAt: new Date(),
        },
      ]).values(),
    ];
    const s = budgetSnapshot(limit(), confirmed);
    expect(s.netPaid).toBe(0n);
    expect(s.available).toBe(K(8_000));
  });

  it('статус оплаты: unknown удерживает, частичная — pending+partial, полный возврат — refunded', () => {
    const e = exp({ amountTotal: K(1_000) });
    expect(paymentStatusOf(e, [{ status: 'unknown' }]).status).toBe('unknown');
    expect(paymentStatusOf(e, [{ status: 'pending' }]).status).toBe('pending');
    expect(
      paymentStatusOf({ ...e, paid: K(400) }, [{ status: 'confirmed' }]),
    ).toEqual({
      status: 'pending',
      partial: true,
    });
    expect(
      paymentStatusOf({ ...e, paid: K(1_000) }, [{ status: 'confirmed' }])
        .status,
    ).toBe('paid');
    expect(
      paymentStatusOf({ ...e, paid: K(1_000), refunded: K(1_000) }, [
        { status: 'confirmed' },
      ]).status,
    ).toBe('refunded');
    expect(paymentStatusOf({ ...e, cancelled: K(1_000) }, []).status).toBe(
      'unpaid',
    );
  });

  it('обязательство не может быть «переплачено» (ошибка кода — исключение)', () => {
    expect(() =>
      openCommitment(exp({ amountTotal: K(1), paid: K(2) })),
    ).toThrow(RangeError);
  });
});

describe('кассовое и экономическое (AI-07), эталон счётчиков', () => {
  it('оказано 1 500, оплачено 1 200 → экономические 1 500, кассовые 1 200', () => {
    const now = new Date();
    const r = cashVsEconomic([
      {
        expenseId: 'e',
        kind: 'deliver',
        amount: K(1_500),
        status: 'confirmed',
        confirmedAt: now,
      },
      {
        expenseId: 'e',
        kind: 'pay',
        amount: K(1_200),
        status: 'confirmed',
        confirmedAt: now,
      },
      {
        expenseId: 'e',
        kind: 'pay',
        amount: K(300),
        status: 'unknown',
        confirmedAt: null,
      },
    ]);
    expect(r).toEqual({
      cashPaid: K(1_200),
      economicDelivered: K(1_500),
      advances: 0n,
    });
  });

  it('expectedCounters = net_paid, open, used по категориям', () => {
    expect(
      expectedCounters([
        exp({ amountTotal: K(2_000), paid: K(2_000) }),
        exp({ amountTotal: K(1_000), category: 'tools' }),
        exp({
          amountTotal: K(500),
          paid: K(500),
          refunded: K(500),
          category: 'other',
        }),
      ]),
    ).toEqual({
      netPaid: K(2_000),
      openCommit: K(1_000),
      usedPlacements: K(2_000),
      usedTools: K(1_000),
    });
  });
});
