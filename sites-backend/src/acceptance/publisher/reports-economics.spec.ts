/**
 * AI Publisher — приёмка P-E: нулевые знаменатели и «не менее» (AT-CORE-18;
 * векторы §9.4, AI-03, AI-07, AI-08). Ожидаемые суммы посчитаны вручную —
 * ход пересчёта в комментариях.
 */
import {
  addCosts,
  allowedOperationalCpl,
  compareWithAllowed,
  directCpl,
  fullOperationalCplTechnical,
  investmentCac,
  investmentCpl,
  knownCost,
  microUsdToMinor,
  operationalCac,
  operationalCost,
  productCpl,
  qualifiedPer100Sessions,
} from '../../modules/publisher/reports/metrics/economics';
import { computeReport } from '../../modules/publisher/reports/metrics/report-compute';
import { td09Inputs } from '../../modules/publisher/reports/testing/td09.testing';

const S2 = {
  // AI-03/07/08: 120 сессий, 3 квалифицированных разных prospect_id, 0 оплат;
  // оказано и оплачено размещений на 1 200 грн.
  sessions: 120,
  qualified: 3,
};

describe('[AT-CORE-18] Нулевой знаменатель: CPL/CAC не рассчитываются, исходные суммы сохранены', () => {
  it('0 заявок → все CPL — not_computable(zero_denominator) с числителем, не 0', () => {
    const cost = knownCost(150_000n);
    const zero = {
      kind: 'not_computable',
      reason: 'zero_denominator',
    };
    expect(directCpl(150_000n, 0)).toEqual({
      ...zero,
      inputs: { numeratorMinor: '150000', technicalQualifiedOfPlacements: 0 },
    });
    expect(fullOperationalCplTechnical(cost, 0)).toEqual({
      ...zero,
      inputs: { numeratorMinor: '150000', technicallyLinkedQualified: 0 },
    });
    expect(productCpl(cost, 0)).toEqual({
      ...zero,
      inputs: { numeratorMinor: '150000', allExternalQualified: 0 },
    });
    expect(investmentCpl(cost, knownCost(300_000n), 0)).toEqual({
      ...zero,
      inputs: { numeratorMinor: '450000', denominator: 0 },
    });
    expect(qualifiedPer100Sessions(3, 0, true)).toEqual({
      ...zero,
      inputs: { qualifiedUnique: 3, sessions: 0 },
    });
  });

  it('AI-08: ноль оплат — CAC не рассчитывается (и инвестиционный тоже), исходные затраты в inputs', () => {
    expect(operationalCac(knownCost(120_000n), 0, 0)).toEqual({
      kind: 'not_computable',
      reason: 'zero_denominator',
      inputs: { numeratorMinor: '120000', newPayingLinked: 0 },
    });
    expect(
      investmentCac(knownCost(120_000n), knownCost(30_000n), 0, 0),
    ).toEqual({
      kind: 'not_computable',
      reason: 'zero_denominator',
      inputs: { numeratorMinor: '150000', newPayingLinked: 0 },
    });
    // Неизвестен статус «новый клиент» — подтверждённый CAC не рассчитывается.
    expect(operationalCac(knownCost(120_000n), 1, 1)).toMatchObject({
      kind: 'not_computable',
      reason: 'new_customer_unknown',
    });
  });

  it('AI-03: прямой CPL 1 200 / 3 = 400 грн; §9.4: оказано 1 500 (300 не оплачено, комиссия 100 внутри) / 3 = 500, не 600 и не 700', () => {
    expect(directCpl(120_000n, S2.qualified)).toEqual({
      kind: 'value',
      value: 40_000n,
    });
    expect(directCpl(150_000n, 3)).toEqual({ kind: 'value', value: 50_000n });
    // Округление вверх до копейки: 1 000,00 / 3 = 333,333… → 333,34.
    expect(directCpl(100_000n, 3)).toEqual({ kind: 'value', value: 33_334n });
    expect(qualifiedPer100Sessions(S2.qualified, S2.sessions, false)).toEqual({
      kind: 'value',
      value: 2.5,
      preliminary: true,
    });
  });

  it('AI-07: оказанное неоплаченное 300 при оплаченных 1 200 → экономические 1 500, кассовые 1 200', () => {
    const c = operationalCost(
      [],
      [
        {
          id: 'e',
          category: 'placements',
          placementId: 'p',
          aiMonth: false,
          deliveredMinor: 150_000n,
          adjustMinor: 0n,
          paidMinor: 120_000n,
          refundedMinor: 0n,
        },
      ],
      [],
      { approved: true, rates: {} },
      null,
    );
    expect(c.operational).toEqual({ kind: 'value', value: 150_000n });
    expect(c.cash).toBe(120_000n);
    expect(c.parts.advancesMinor).toBe(0n);
  });

  it('неизвестная ставка → «не менее» (lowerBound + unknownParts); сравнение с допустимым CPL — not_computable(unknown_input)', () => {
    // 120 мин без ставки, 60 мин по 300,00 грн/ч = 300,00 грн.
    const c = operationalCost(
      [
        {
          minutes: 120,
          role: 'editor',
          rateMinorPerHour: null,
          isInvestment: false,
        },
        {
          minutes: 60,
          role: 'analyst',
          rateMinorPerHour: 30_000n,
          isInvestment: false,
        },
      ],
      [],
      [],
      { approved: false, rates: { editor: 50_000 } },
      null,
    );
    expect(c.operational).toEqual({
      kind: 'value',
      value: 30_000n,
      lowerBound: true,
      unknownParts: ['labor:minutes_without_rate'],
    });
    expect(c.parts.minutesWithoutRate).toEqual({
      operational: 120,
      investment: 0,
    });
    const cpl = fullOperationalCplTechnical(c.operational, 2);
    expect(cpl).toEqual({
      kind: 'value',
      value: 15_000n,
      lowerBound: true,
      unknownParts: ['labor:minutes_without_rate'],
    });
    // Допустимый: floor(10 001 × 3 333 × 5 000 / 10⁸) = floor(1 666,66665) = 1 666.
    const allowed = allowedOperationalCpl({
      contributionMinor: 10_001n,
      pPayBp: 3_333,
      shareBp: 5_000,
    });
    expect(allowed).toEqual({ kind: 'value', value: 1_666n });
    expect(compareWithAllowed(cpl, allowed)).toEqual({
      kind: 'not_computable',
      reason: 'unknown_input',
      inputs: { cplMinor: '15000', cplLowerBound: 1, allowedMinor: '1666' },
    });
    // Утверждённая ставка роли закрывает неизвестную часть: 120 × 500,00 / 60 = 1 000,00.
    const known = operationalCost(
      [
        {
          minutes: 120,
          role: 'editor',
          rateMinorPerHour: null,
          isInvestment: false,
        },
      ],
      [],
      [],
      { approved: true, rates: { editor: 50_000 } },
      null,
    );
    expect(known.operational).toEqual({ kind: 'value', value: 100_000n });
    expect(
      compareWithAllowed(
        fullOperationalCplTechnical(known.operational, 100),
        allowed,
      ),
    ).toEqual({
      kind: 'value',
      value: 'within',
    }); // 1 000,00 / 100 = 10,00 ≤ 16,66
  });

  it('допустимый CPL: неизвестный/неположительный вклад и значения вне диапазона не утверждают положительный порог', () => {
    expect(
      allowedOperationalCpl({ contributionMinor: null, pPayBp: 1, shareBp: 1 }),
    ).toMatchObject({ reason: 'unknown_input' });
    expect(
      allowedOperationalCpl({ contributionMinor: 0n, pPayBp: 1, shareBp: 1 }),
    ).toMatchObject({
      reason: 'non_positive_contribution',
    });
    expect(
      allowedOperationalCpl({ contributionMinor: -5n, pPayBp: 1, shareBp: 1 }),
    ).toMatchObject({
      reason: 'non_positive_contribution',
    });
    expect(
      allowedOperationalCpl({
        contributionMinor: 1n,
        pPayBp: 10_001,
        shareBp: 1,
      }),
    ).toMatchObject({
      reason: 'probability_out_of_range',
    });
    expect(
      allowedOperationalCpl({ contributionMinor: 1n, pPayBp: -1, shareBp: 1 }),
    ).toMatchObject({
      reason: 'probability_out_of_range',
    });
    expect(
      allowedOperationalCpl({ contributionMinor: 1n, pPayBp: 1, shareBp: 0 }),
    ).toMatchObject({
      reason: 'share_out_of_range',
    });
    expect(
      allowedOperationalCpl({
        contributionMinor: 1n,
        pPayBp: 1,
        shareBp: 10_001,
      }),
    ).toMatchObject({
      reason: 'share_out_of_range',
    });
    // Границы допустимы: p = 0 → 0; доля = 1 → весь вклад × p.
    expect(
      allowedOperationalCpl({
        contributionMinor: 1_000n,
        pPayBp: 0,
        shareBp: 10_000,
      }),
    ).toEqual({ kind: 'value', value: 0n });
    expect(
      allowedOperationalCpl({
        contributionMinor: 1_000n,
        pPayBp: 10_000,
        shareBp: 10_000,
      }),
    ).toEqual({
      kind: 'value',
      value: 1_000n,
    });
  });

  it('AI без цены и курса — «не менее»; курс: 2 000 000 micro-USD × 41,5 = 83,00 грн; повторные вызовы входят', () => {
    expect(microUsdToMinor(2_000_000n, '41.5')).toBe(8_300n);
    expect(microUsdToMinor(1n, '41.5')).toBe(1n); // вверх до копейки
    const noFx = operationalCost(
      [],
      [],
      [{ costMicroUsd: 1_000_000n, costStatus: 'priced' }],
      { approved: true, rates: {} },
      null,
    );
    expect(noFx.operational).toEqual({
      kind: 'value',
      value: 0n,
      lowerBound: true,
      unknownParts: ['ai:no_fx_rate'],
    });
    const unpriced = operationalCost(
      [],
      [],
      [{ costMicroUsd: null, costStatus: 'unpriced' }],
      { approved: true, rates: {} },
      '41.5',
    );
    expect(unpriced.operational).toMatchObject({
      lowerBound: true,
      unknownParts: ['ai:unpriced_calls'],
    });
    expect(addCosts(knownCost(1n), unpriced.operational)).toMatchObject({
      value: 1n,
      lowerBound: true,
    });
  });

  it('снимок TD-09 (D72): числа и «не менее» в блоке economics посчитаны вручную', () => {
    // Операционная: труд аналитика 120 мин × 300,00/ч = 600,00; закупка оказано 1 500,00;
    // инструменты 200,00; AI 2 × $1 × 41,5 = 83,00; = 2 383,00 (не менее: 120 мин без ставки, AI без цены).
    // Инвестиции: настройка 600 мин × 300,00/ч = 3 000,00. Касса: 1 200 + 200 + 500 (AI-месяц) = 1 900,00.
    // AI-месяц оказан на 500,00, но в экономику не входит (вызовы уже 83,00) — иначе 2 883,00.
    // Авансов нет: закупка А оплачена 1 200 < оказано 1 500; AI-месяц 500 = 500.
    const r = computeReport(td09Inputs());
    const costs = r.costs as {
      economic: { operational: unknown; investment: unknown };
      cash: { netPaidMinor: string; advancesMinor: string };
    };
    const lb = {
      lowerBound: true,
      unknownParts: ['ai:unpriced_calls', 'labor:minutes_without_rate'],
    };
    expect(costs.economic.operational).toEqual({
      kind: 'value',
      value: '238300',
      ...lb,
    });
    expect(costs.economic.investment).toEqual({
      kind: 'value',
      value: '300000',
    });
    expect(costs.cash).toEqual({
      netPaidMinor: '190000',
      advancesMinor: '0',
    });
    const e = (r.metrics as { economics: Record<string, unknown> }).economics;
    // Прямой: 1 500,00 / 2 связанных (P1, P3 через размещение А) = 750,00.
    expect(e.directCpl).toEqual({ kind: 'value', value: '75000' });
    // Полный операционный технический: 2 383,00 / 2 = 1 191,50 (не менее).
    expect(e.fullOperationalCplTechnical).toEqual({
      kind: 'value',
      value: '119150',
      ...lb,
    });
    // Продуктовый: 2 383,00 / 2 внешних квалифицированных когорты (P1, P3;
    // P8 — сессия ровно в t42, вне когорты) = 1 191,50 (не менее).
    expect(e.productCpl).toEqual({ kind: 'value', value: '119150', ...lb });
    // Инвестиционный: (2 383,00 + 3 000,00) / 2 = 2 691,50 (не менее).
    expect(e.investmentCpl).toEqual({ kind: 'value', value: '269150', ...lb });
    expect(e.allowedOperationalCpl).toEqual({ kind: 'value', value: '1666' });
    expect(e.economicSignal).toEqual({
      kind: 'not_computable',
      reason: 'unknown_input',
      inputs: { cplMinor: '119150', cplLowerBound: 1, allowedMinor: '1666' },
    });
    // CAC: один новый внешний оплативший (P1, связан) → 2 383,00 (не менее).
    expect(e.operationalCac).toEqual({ kind: 'value', value: '238300', ...lb });
    expect(e.newPayingLinked).toBe(1);
  });

  it('снимок без заявок и оплат: CPL/CAC «не рассчитывается» с исходными суммами, а не 0', () => {
    const r = computeReport(
      td09Inputs({ leads: [], decisions: [], links: [], payments: [] }),
    );
    const e = (
      r.metrics as {
        economics: Record<
          string,
          { kind: string; reason?: string; inputs?: Record<string, unknown> }
        >;
      }
    ).economics;
    for (const k of [
      'directCpl',
      'fullOperationalCplTechnical',
      'productCpl',
      'investmentCpl',
      'operationalCac',
      'investmentCac',
    ]) {
      expect(e[k]).toMatchObject({
        kind: 'not_computable',
        reason: 'zero_denominator',
      });
      expect(e[k].inputs?.numeratorMinor).toMatch(/^\d+$/);
    }
    expect(e.fullOperationalCplTechnical.inputs).toEqual({
      numeratorMinor: '238300',
      numeratorLowerBound: 1,
      technicallyLinkedQualified: 0,
    });
  });

  it('AI-месяц: оказанный счёт месяца (500,00) не входит в экономику — AI уже по вызовам (83,00), без двойного учёта', () => {
    const r = computeReport(td09Inputs());
    const parts = (r.costs as { parts: Record<string, unknown> }).parts;
    // Инструменты — только ex_tools 200,00; AI — вызовы 83,00; счёт AI-месяца
    // (оказано 500,00) не прибавлен ни к инструментам, ни к AI.
    expect(parts.toolsDeliveredMinor).toBe('20000');
    expect(parts.aiMinor).toBe('8300');
    // Тот же счёт без пометки AI-месяца — обычный инструмент: +500,00.
    const plain = computeReport(
      td09Inputs({
        expenses: td09Inputs().expenses.map((x) => ({ ...x, aiMonth: false })),
      }),
    );
    expect(
      (plain.costs as { parts: Record<string, unknown> }).parts
        .toolsDeliveredMinor,
    ).toBe('70000');
  });

  it('CAC: оплата НЕ нового клиента (isNewCustomer=no) — не новый оплативший; неизвестный статус — CAC не подтверждается', () => {
    const base = td09Inputs();
    const old = {
      ...base.payments[0],
      id: 'pay_old',
      prospectId: 'P3',
      leadId: 'L3',
      isNewCustomer: 'no' as const,
    };
    const r = computeReport({ ...base, payments: [...base.payments, old] });
    const e = (r.metrics as { economics: Record<string, unknown> }).economics;
    // Новых связанных оплативших по-прежнему один (P1); P3 — «старый» клиент.
    expect(e.newPayingLinked).toBe(1);
    expect(e.newCustomerUnknown).toBe(0);
    expect(e.operationalCac).toMatchObject({ kind: 'value', value: '238300' });
    const unknown = computeReport({
      ...base,
      payments: [...base.payments, { ...old, isNewCustomer: 'unknown' }],
    });
    expect(
      (unknown.metrics as { economics: Record<string, unknown> }).economics
        .operationalCac,
    ).toMatchObject({ kind: 'not_computable', reason: 'new_customer_unknown' });
  });

  it('опубликованное оплаченное размещение без отметки «оказано» — прямой CPL «не рассчитывается», а не 0; частичное — «не менее»', () => {
    const base = td09Inputs();
    // Закупка А: обязательство 1 500, оплачено 1 200, «оказано» не отмечено.
    const noDeliver = base.expenseEntries.filter(
      (x) => !(x.expenseId === 'ex_a' && x.kind === 'deliver'),
    );
    const r = computeReport({ ...base, expenseEntries: noDeliver });
    const e = (r.metrics as { economics: Record<string, unknown> }).economics;
    expect(e.directCpl).toEqual({
      kind: 'not_computable',
      reason: 'unknown_input',
      inputs: {
        deliveredMinor: '0',
        deliveryUnconfirmed: 1,
        technicalQualifiedOfPlacements: 2,
      },
    });
    const pl = (
      r.metrics as {
        placements: Array<{ id: string; deliveryUnconfirmed: boolean }>;
      }
    ).placements.find((x) => x.id === 'pl_a');
    expect(pl?.deliveryUnconfirmed).toBe(true);
    // Операционная — «не менее» с причиной: 2 383,00 − 1 500,00 = 883,00.
    expect(
      (r.costs as { economic: { operational: unknown } }).economic.operational,
    ).toEqual({
      kind: 'value',
      value: '88300',
      lowerBound: true,
      unknownParts: [
        'ai:unpriced_calls',
        'labor:minutes_without_rate',
        'placement:delivery_unconfirmed',
      ],
    });
    // Оказано 1 000 из обязательства 1 500: прямой не менее 1 000 / 2 = 500,00.
    const partial = computeReport({
      ...base,
      expenseEntries: noDeliver.concat({
        expenseId: 'ex_a',
        kind: 'deliver',
        status: 'confirmed',
        amountMinor: 100_000n,
        occurredAt: new Date('2026-10-20T07:00:00.000Z'),
        confirmedAt: new Date('2026-10-20T07:00:00.000Z'),
      }),
    });
    expect(
      (partial.metrics as { economics: Record<string, unknown> }).economics
        .directCpl,
    ).toEqual({
      kind: 'value',
      value: '50000',
      lowerBound: true,
      unknownParts: ['placement:delivery_unconfirmed'],
    });
    expect(directCpl(150_000n, 3, { deliveryUnconfirmed: 0 })).toEqual({
      kind: 'value',
      value: 50_000n,
    });
  });

  it('снимок D42 (окно открыто): CPL и CAC помечены «предварительно»; D72 (окно закрыто) — нет', () => {
    const d42 = computeReport(
      td09Inputs({
        kind: 'd42',
        snapshotAt: new Date('2026-12-01T08:00:00.000Z'),
      }),
    );
    const e = (d42.metrics as { economics: Record<string, unknown> }).economics;
    for (const k of [
      'directCpl',
      'fullOperationalCplTechnical',
      'productCpl',
      'investmentCpl',
    ]) {
      expect([k, e[k]]).toEqual([
        k,
        expect.objectContaining({ kind: 'value', preliminary: true }),
      ]);
    }
    const d72 = (
      computeReport(td09Inputs()).metrics as {
        economics: Record<string, { preliminary?: boolean }>;
      }
    ).economics;
    expect(d72.productCpl.preliminary).toBeUndefined();
    // До t72 (20.12): оплата P1 10.12 уже есть — CAC рассчитан, но предварительно.
    const mid = computeReport(
      td09Inputs({ snapshotAt: new Date('2026-12-20T10:00:00.000Z') }),
    );
    expect(
      (mid.metrics as { economics: Record<string, unknown> }).economics
        .operationalCac,
    ).toMatchObject({ kind: 'value', preliminary: true });
  });
});

describe('[AT-CORE-18] Р-PUB-Z2-24 (B1-F-02): пакет разработки P0 (`dev_investment`) — неизвестное ≠ 0', () => {
  const econ = (r: ReturnType<typeof computeReport>) =>
    (r.metrics as { economics: Record<string, unknown> }).economics;
  const inv = (r: ReturnType<typeof computeReport>) =>
    (r.costs as { economic: { operational: unknown; investment: unknown } })
      .economic;

  it('сумма неизвестна (допущение, null) — инвестиции и инвестиционные CPL/CAC «не менее», операционные как без пакета', () => {
    const base = computeReport(td09Inputs());
    const unknown = computeReport(
      td09Inputs({ devInvestment: { approved: false, amountMinor: null } }),
    );
    // Операционная часть и операционные показатели не меняются.
    expect(inv(unknown).operational).toEqual(inv(base).operational);
    for (const k of [
      'directCpl',
      'fullOperationalCplTechnical',
      'productCpl',
      'operationalCac',
      'economicSignal',
    ])
      expect({ k, v: econ(unknown)[k] }).toEqual({ k, v: econ(base)[k] });
    // Инвестиции: 3 000,00 настройки + пакет неизвестен → «не менее».
    expect(inv(unknown).investment).toEqual({
      kind: 'value',
      value: '300000',
      lowerBound: true,
      unknownParts: ['dev_investment:unknown'],
    });
    const cpl = econ(unknown).investmentCpl as {
      kind: string;
      lowerBound?: boolean;
      unknownParts?: string[];
    };
    expect(cpl.kind).toBe('value');
    expect(cpl.lowerBound).toBe(true);
    expect(cpl.unknownParts).toContain('dev_investment:unknown');
    // Инвестиционный CAC — тоже «не менее» (оплатившие TD-09 есть).
    const cac = econ(unknown).investmentCac as typeof cpl;
    expect(cac.kind).toBe('value');
    expect(cac.lowerBound).toBe(true);
    expect(cac.unknownParts).toContain('dev_investment:unknown');
    // Сумма-допущение (не утверждена) — тоже «не менее», не вклад в сумму.
    const assumed = computeReport(
      td09Inputs({ devInvestment: { approved: false, amountMinor: 900_000 } }),
    );
    expect(inv(assumed).investment).toEqual(inv(unknown).investment);
  });

  it('утверждённая сумма — входит в инвестиции точно; 0 — явное «разработки нет», а не неизвестное', () => {
    const known = computeReport(
      td09Inputs({ devInvestment: { approved: true, amountMinor: 900_000 } }),
    );
    // 3 000,00 настройки + 9 000,00 пакета = 12 000,00 — без «не менее».
    expect(inv(known).investment).toEqual({ kind: 'value', value: '1200000' });
    expect(
      (known.costs as { parts: Record<string, unknown> }).parts
        .devInvestmentMinor,
    ).toBe('900000');
    const zero = computeReport(
      td09Inputs({ devInvestment: { approved: true, amountMinor: 0 } }),
    );
    expect(inv(zero).investment).toEqual({ kind: 'value', value: '300000' });
    // Формулы: неизвестный пакет при нулевом знаменателе — не рассчитывается.
    const op = knownCost(100_000n);
    const unknownInv = operationalCost(
      [],
      [],
      [],
      { approved: true, rates: {} },
      null,
      {
        devInvestment: null,
      },
    ).investment;
    expect(investmentCpl(op, unknownInv, 0)).toMatchObject({
      kind: 'not_computable',
      reason: 'zero_denominator',
    });
    expect(investmentCac(op, unknownInv, 2, 0)).toMatchObject({
      kind: 'value',
      value: 50_000n,
      lowerBound: true,
    });
  });
});
