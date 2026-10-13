/**
 * AI Publisher — показатели отчётов (P-E, проектный документ §9.4; ТЗ
 * §15–16; AT-CORE-18, AT-CORE-23, AT-CORE-24, AT-F17-02). Чистые функции:
 * без Nest, базы и env; деньги — `bigint` в минимальных единицах.
 *
 * Правила «неизвестное ≠ ноль» (§1 п.2, §9):
 *  - нулевой знаменатель → `not_computable('zero_denominator')` с
 *    числителем в `inputs` (AT-CORE-18, AI-08): отчёт пишет «не
 *    рассчитывается» и исходные суммы, график точку не рисует;
 *  - в числителе неизвестные части (минуты без утверждённой ставки, AI без
 *    цены или без курса) → значение с `lowerBound: true` и `unknownParts`
 *    («не менее …»); сравнение такого значения с порогом —
 *    `not_computable('unknown_input')` (аудит P2-5);
 *  - CPL/CAC — экономическая стоимость (оказано, начислено), кассовая —
 *    рядом (аудит P3-17); стоимость на единицу округляется ВВЕРХ до
 *    копейки (консервативно при сравнении с допустимым CPL, который
 *    округляется вниз).
 */
import type { Bp, Computable, Minor } from '../../contracts/common';
import { divRound, parseFxRate } from '../../core/money';

export type Cost = Computable<Minor>;

// ── Вспомогательное ──────────────────────────────────────────────────────

const zero = (inputs: Record<string, string | number | null>): Cost => ({
  kind: 'not_computable',
  reason: 'zero_denominator',
  inputs,
});

function numeratorInputs(
  cost: Cost,
  den: number,
  denName: string,
): Record<string, string | number | null> {
  return {
    numeratorMinor: cost.kind === 'value' ? cost.value.toString() : null,
    ...(cost.kind === 'value' && cost.lowerBound
      ? { numeratorLowerBound: 1 }
      : {}),
    [denName]: den,
  };
}

/** Стоимость на единицу: ceil(cost / den); 0 — «не рассчитывается». */
export function costPer(cost: Cost, den: number, denName: string): Cost {
  if (!Number.isSafeInteger(den) || den < 0) {
    throw new RangeError(`costPer: ${denName} — целое ≥ 0`);
  }
  if (cost.kind === 'not_computable') return cost;
  if (den === 0) return zero(numeratorInputs(cost, den, denName));
  return {
    kind: 'value',
    value: divRound(cost.value, BigInt(den), 'ceil'),
    ...(cost.lowerBound
      ? { lowerBound: true, unknownParts: cost.unknownParts ?? [] }
      : {}),
  };
}

/** Сумма стоимостей: неизвестная часть любой — `lowerBound` у суммы. */
export function addCosts(...costs: Cost[]): Cost {
  let value = 0n;
  const unknown: string[] = [];
  let lower = false;
  for (const c of costs) {
    if (c.kind === 'not_computable') return c;
    value += c.value;
    if (c.lowerBound) {
      lower = true;
      unknown.push(...(c.unknownParts ?? []));
    }
  }
  return lower
    ? {
        kind: 'value',
        value,
        lowerBound: true,
        unknownParts: [...new Set(unknown)],
      }
    : { kind: 'value', value };
}

export const knownCost = (value: Minor): Cost => ({ kind: 'value', value });

// ── Каналы и продукт ─────────────────────────────────────────────────────

/**
 * Квалифицированные потенциальные клиенты на 100 измеряемых сессий (ТЗ
 * §15) — не доля людей. Окно не закрыто — `preliminary`; сессии неизвестны
 * — `unknown_input`; 0 сессий — `zero_denominator`.
 */
export function qualifiedPer100Sessions(
  qualifiedUnique: number,
  sessions: number | null,
  windowClosed: boolean,
): Computable<number> {
  if (sessions === null) {
    return {
      kind: 'not_computable',
      reason: 'unknown_input',
      inputs: { qualifiedUnique, sessions: null },
    };
  }
  if (sessions === 0) {
    return {
      kind: 'not_computable',
      reason: 'zero_denominator',
      inputs: { qualifiedUnique, sessions },
    };
  }
  return {
    kind: 'value',
    value: Math.round((qualifiedUnique * 100 * 100) / sessions) / 100,
    ...(windowClosed ? {} : { preliminary: true }),
  };
}

/**
 * Прямой экономический CPL размещений (ТЗ §15, аудит P2-4): числитель =
 * Σ оказанного по расходам закупок (цена уже с комиссиями) + Σ
 * подтверждённых корректировок; авансы (paid − delivered) не входят;
 * `delivered_unpaid` и комиссии отдельно НЕ прибавляются (они внутри
 * delivered). Знаменатель — уникальные квалифицированные проспекты,
 * технически атрибутированные этим размещениям.
 *
 * Размещение опубликовано, а оказание не подтверждено (обязательство или
 * оплата больше оказанного, аудит P-E S2-4): числитель неизвестен —
 * при известной части «не менее» (`lowerBound`, `placement:delivery_unconfirmed`),
 * при нуле оказанного — `unknown_input`, а не «0 грн за заявку».
 */
export function directCpl(
  deliveredPlacementCost: Minor,
  technicalQualifiedOfPlacements: number,
  opts: { deliveryUnconfirmed?: number } = {},
): Cost {
  const unconfirmed = opts.deliveryUnconfirmed ?? 0;
  if (unconfirmed > 0) {
    if (deliveredPlacementCost <= 0n) {
      return {
        kind: 'not_computable',
        reason: 'unknown_input',
        inputs: {
          deliveredMinor: deliveredPlacementCost.toString(),
          deliveryUnconfirmed: unconfirmed,
          technicalQualifiedOfPlacements,
        },
      };
    }
    return costPer(
      {
        kind: 'value',
        value: deliveredPlacementCost,
        lowerBound: true,
        unknownParts: ['placement:delivery_unconfirmed'],
      },
      technicalQualifiedOfPlacements,
      'technicalQualifiedOfPlacements',
    );
  }
  return costPer(
    knownCost(deliveredPlacementCost),
    technicalQualifiedOfPlacements,
    'technicalQualifiedOfPlacements',
  );
}

/**
 * Показатель при незакрытом окне обращения — «предварительно» (аудит P-E
 * S3-6): CPL/CAC снимка D42 не выглядят окончательными.
 */
export function preliminaryIf<T>(
  c: Computable<T>,
  open: boolean,
): Computable<T> {
  return open && c.kind === 'value' ? { ...c, preliminary: true } : c;
}

/** Полный операционный CPL, технический знаменатель кампании (консервативный при неполном покрытии). */
export function fullOperationalCplTechnical(
  operationalCost: Cost,
  technicallyLinkedQualified: number,
): Cost {
  return costPer(
    operationalCost,
    technicallyLinkedQualified,
    'technicallyLinkedQualified',
  );
}

/** Продуктовый CPL: тот же числитель / все внешние квалифицированные (не «канальный»). */
export function productCpl(
  operationalCost: Cost,
  allExternalQualified: number,
): Cost {
  return costPer(operationalCost, allExternalQualified, 'allExternalQualified');
}

/** Инвестиционный CPL: операционная + настройка/разработка. */
export function investmentCpl(
  operationalCost: Cost,
  setupAndDevCost: Cost,
  denominator: number,
): Cost {
  return costPer(
    addCosts(operationalCost, setupAndDevCost),
    denominator,
    'denominator',
  );
}

/**
 * Операционный CAC: затраты привлечения / новые внешние оплатившие,
 * технически связанные. Хоть у одного оплатившего статус «новый клиент»
 * неизвестен — основной CAC не подтверждается (`new_customer_unknown`).
 */
export function operationalCac(
  acquisitionCost: Cost,
  newPayingLinked: number,
  newCustomerUnknownCount: number,
): Cost {
  if (newCustomerUnknownCount > 0) {
    return {
      kind: 'not_computable',
      reason: 'new_customer_unknown',
      inputs: {
        numeratorMinor:
          acquisitionCost.kind === 'value'
            ? acquisitionCost.value.toString()
            : null,
        newPayingLinked,
        newCustomerUnknown: newCustomerUnknownCount,
      },
    };
  }
  return costPer(acquisitionCost, newPayingLinked, 'newPayingLinked');
}

export function investmentCac(
  acquisitionCost: Cost,
  setupAndDevCost: Cost,
  newPayingLinked: number,
  unknownCount: number,
): Cost {
  return operationalCac(
    addCosts(acquisitionCost, setupAndDevCost),
    newPayingLinked,
    unknownCount,
  );
}

/**
 * Допустимый операционный CPL (ТЗ §16, аудит P3-16): floor(вклад × pPayBp ×
 * shareBp / 10⁸). Вклад неизвестен — `unknown_input`; ≤ 0 —
 * `non_positive_contribution`; вероятность ∉ [0, 10000] —
 * `probability_out_of_range`; доля ∉ (0, 10000] — `share_out_of_range`.
 */
export function allowedOperationalCpl(i: {
  contributionMinor: Minor | null;
  pPayBp: Bp | null;
  shareBp: Bp | null;
}): Cost {
  const inputs = {
    contributionMinor:
      i.contributionMinor === null ? null : i.contributionMinor.toString(),
    pPayBp: i.pPayBp,
    shareBp: i.shareBp,
  };
  if (i.contributionMinor === null || i.pPayBp === null || i.shareBp === null) {
    return { kind: 'not_computable', reason: 'unknown_input', inputs };
  }
  if (i.contributionMinor <= 0n) {
    return {
      kind: 'not_computable',
      reason: 'non_positive_contribution',
      inputs,
    };
  }
  if (!Number.isInteger(i.pPayBp) || i.pPayBp < 0 || i.pPayBp > 10_000) {
    return {
      kind: 'not_computable',
      reason: 'probability_out_of_range',
      inputs,
    };
  }
  if (!Number.isInteger(i.shareBp) || i.shareBp <= 0 || i.shareBp > 10_000) {
    return { kind: 'not_computable', reason: 'share_out_of_range', inputs };
  }
  return {
    kind: 'value',
    value: divRound(
      i.contributionMinor * BigInt(i.pPayBp) * BigInt(i.shareBp),
      100_000_000n,
      'floor',
    ),
  };
}

/**
 * Экономический сигнал (ТЗ §16): операционный CPL против допустимого. Любое
 * из значений не рассчитано или известно только «не менее» —
 * `not_computable('unknown_input')` (или причина самого CPL).
 */
export function compareWithAllowed(
  cpl: Cost,
  allowed: Cost,
): Computable<'within' | 'above'> {
  if (cpl.kind === 'not_computable') return cpl;
  if (allowed.kind === 'not_computable') {
    return {
      kind: 'not_computable',
      reason: 'unknown_input',
      inputs: { ...allowed.inputs, allowed: null },
    };
  }
  if (cpl.lowerBound || allowed.lowerBound) {
    return {
      kind: 'not_computable',
      reason: 'unknown_input',
      inputs: {
        cplMinor: cpl.value.toString(),
        cplLowerBound: cpl.lowerBound ? 1 : 0,
        allowedMinor: allowed.value.toString(),
      },
    };
  }
  return {
    kind: 'value',
    value: cpl.value <= allowed.value ? 'within' : 'above',
  };
}

// ── Стоимость ────────────────────────────────────────────────────────────

export interface TimeEntryCostIn {
  minutes: number;
  role: string;
  /** Ставка, зафиксированная в записи; null — не утверждена при записи. */
  rateMinorPerHour: Minor | null;
  /** setup|development (триггер `isInvestment`). */
  isInvestment: boolean;
}

export interface ExpenseCostIn {
  id: string;
  category: 'placements' | 'tools' | 'other';
  placementId: string | null;
  /**
   * Обязательство месяца AI (`pub_ai_budget_months.expenseId`): его
   * экономика — фактические вызовы, а не счёт, иначе AI посчитан дважды.
   */
  aiMonth: boolean;
  /** Оказано на снимок (Σ confirmed `deliver`). */
  deliveredMinor: Minor;
  /** Σ подтверждённых `adjust` на снимок (со знаком). */
  adjustMinor: Minor;
  /** Касса на снимок: Σ confirmed `pay` и `refund`. */
  paidMinor: Minor;
  refundedMinor: Minor;
}

export interface AiCallCostIn {
  costMicroUsd: bigint | null;
  costStatus: 'priced' | 'unpriced' | 'unknown';
}

export interface RatesIn {
  /** `rates_by_role` утверждён (иначе ставки параметра не применяются). */
  approved: boolean;
  rates: Record<string, number | null>;
}

export interface CostBreakdown {
  operational: Cost;
  /** Настройка и разработка (инвестиции, ТЗ §17) — без операционной части. */
  investment: Cost;
  /** Кассовые расходы: Σ (paid − refunded) всех обязательств. */
  cash: Minor;
  parts: {
    laborOperationalMinor: Minor;
    laborInvestmentMinor: Minor;
    /** Пакет разработки (Р-PUB-Z2-24); нет поля — неизвестен или не задан. */
    devInvestmentMinor?: Minor;
    placementsDeliveredMinor: Minor;
    toolsDeliveredMinor: Minor;
    aiMinor: Minor;
    advancesMinor: Minor;
    minutesWithoutRate: { operational: number; investment: number };
    aiCallsUnpriced: number;
  };
}

const MICRO_PER_CENT = 10_000n; // 1 цент = 10 000 micro-USD

/** micro-USD → минимальные единицы валюты лимита по курсу (вверх). */
export function microUsdToMinor(microUsd: bigint, rate: string): Minor {
  // micro-USD / 10 000 = центы; центы × курс (1e-8) — копейки.
  return divRound(
    microUsd * parseFxRate(rate),
    MICRO_PER_CENT * 100_000_000n,
    'ceil',
  );
}

/**
 * Экономическая стоимость (ТЗ §15): начисленный труд по ставкам ролей,
 * оказанные услуги закупок и инструментов, фактические AI-вызовы (с
 * повторными). Минуты без ставки и AI без цены/курса — `lowerBound` +
 * `unknownParts`. Одна сумма труда — в одной категории (`isInvestment`).
 */
export function operationalCost(
  timeEntries: readonly TimeEntryCostIn[],
  expenses: readonly ExpenseCostIn[],
  aiCalls: readonly AiCallCostIn[],
  rates: RatesIn,
  aiFxRate: string | null,
  opts: {
    placementDeliveryUnconfirmed?: number;
    /**
     * Пакет разработки P0 (Р-PUB-Z2-24): сумма → в инвестиционную часть;
     * `null` — неизвестна: инвестиции «не менее» (`dev_investment:unknown`),
     * не 0; `undefined` — вход не задан (прежнее поведение).
     */
    devInvestment?: Minor | null;
  } = {},
): CostBreakdown {
  const labor = { op: 0n, inv: 0n };
  const noRate = { op: 0, inv: 0 };
  for (const t of timeEntries) {
    const paramRate = rates.approved ? rates.rates[t.role] : null;
    const rate =
      t.rateMinorPerHour ??
      (typeof paramRate === 'number' && Number.isSafeInteger(paramRate)
        ? BigInt(paramRate)
        : null);
    if (rate === null) {
      if (t.isInvestment) noRate.inv += t.minutes;
      else noRate.op += t.minutes;
      continue;
    }
    if (t.isInvestment) labor.inv += BigInt(t.minutes) * rate;
    else labor.op += BigInt(t.minutes) * rate;
  }
  const laborOp = divRound(labor.op, 60n, 'half_up');
  const laborInv = divRound(labor.inv, 60n, 'half_up');

  let placements = 0n;
  let tools = 0n;
  let cash = 0n;
  let advances = 0n;
  for (const e of expenses) {
    cash += e.paidMinor - e.refundedMinor;
    const adv = e.paidMinor - e.refundedMinor - e.deliveredMinor;
    if (adv > 0n) advances += adv;
    if (e.aiMonth) continue;
    const economic = e.deliveredMinor + e.adjustMinor;
    if (e.category === 'placements') placements += economic;
    else tools += economic;
  }

  let ai = 0n;
  let unpriced = 0;
  let aiPriced = 0n;
  for (const c of aiCalls) {
    if (c.costMicroUsd === null || c.costStatus !== 'priced') unpriced++;
    else aiPriced += c.costMicroUsd;
  }
  const unknownOp: string[] = [];
  if (aiPriced > 0n) {
    if (aiFxRate) ai = microUsdToMinor(aiPriced, aiFxRate);
    else unknownOp.push('ai:no_fx_rate');
  }
  if (unpriced > 0) unknownOp.push('ai:unpriced_calls');
  if (noRate.op > 0) unknownOp.push('labor:minutes_without_rate');
  if ((opts.placementDeliveryUnconfirmed ?? 0) > 0)
    unknownOp.push('placement:delivery_unconfirmed');
  const operationalValue = laborOp + placements + tools + ai;
  const operational: Cost = unknownOp.length
    ? {
        kind: 'value',
        value: operationalValue,
        lowerBound: true,
        unknownParts: unknownOp,
      }
    : { kind: 'value', value: operationalValue };
  const unknownInv: string[] = [];
  if (noRate.inv > 0) unknownInv.push('labor:investment_minutes_without_rate');
  if (opts.devInvestment === null) unknownInv.push('dev_investment:unknown');
  const dev = opts.devInvestment ?? 0n;
  const investment: Cost = unknownInv.length
    ? {
        kind: 'value',
        value: laborInv + dev,
        lowerBound: true,
        unknownParts: unknownInv,
      }
    : { kind: 'value', value: laborInv + dev };
  return {
    operational,
    investment,
    cash,
    parts: {
      laborOperationalMinor: laborOp,
      laborInvestmentMinor: laborInv,
      ...(opts.devInvestment !== undefined && opts.devInvestment !== null
        ? { devInvestmentMinor: opts.devInvestment }
        : {}),
      placementsDeliveredMinor: placements,
      toolsDeliveredMinor: tools,
      aiMinor: ai,
      advancesMinor: advances,
      minutesWithoutRate: { operational: noRate.op, investment: noRate.inv },
      aiCallsUnpriced: unpriced,
    },
  };
}

// ── Сигналы и заключения ─────────────────────────────────────────────────

export type Verdict = 'met' | 'not_met' | 'inconclusive';
type Part = 'met' | 'not_met' | 'unknown';

function verdictOf(parts: readonly Part[]): Verdict {
  if (parts.includes('not_met')) return 'not_met';
  if (parts.includes('unknown')) return 'inconclusive';
  return 'met';
}

const part = (v: number | null, th: number): Part =>
  v === null ? 'unknown' : v >= th ? 'met' : 'not_met';

/**
 * Предварительный сигнал спроса D42 (ТЗ §16): ≥ sessions измеряемых
 * сессий, ≥ qualified уникальных внешних квалифицированных, ≥ proposals
 * предложений разным проспектам. Пороги — ЗАМОРОЖЕННЫЕ в эксперименте
 * (AT-CORE-23): результат ниже порога — `not_met`, порог не «подтягивается».
 * Связанные и неизвестные — в частях, отдельно от общего числа.
 */
export function signalD42(
  i: {
    sessions: number | null;
    qualifiedUnique: number;
    linked: number;
    unknown: number;
    proposalsToDistinct: number;
  },
  th: { sessions: number; qualified: number; proposals: number },
): {
  verdict: Verdict;
  parts: {
    sessions: { value: number | null; threshold: number; state: Part };
    qualified: {
      value: number;
      threshold: number;
      state: Part;
      linked: number;
      unknown: number;
    };
    proposals: { value: number; threshold: number; state: Part };
  };
} {
  const s = part(i.sessions, th.sessions);
  const q = part(i.qualifiedUnique, th.qualified);
  const p = part(i.proposalsToDistinct, th.proposals);
  return {
    verdict: verdictOf([s, q, p]),
    parts: {
      sessions: { value: i.sessions, threshold: th.sessions, state: s },
      qualified: {
        value: i.qualifiedUnique,
        threshold: th.qualified,
        state: q,
        linked: i.linked,
        unknown: i.unknown,
      },
      proposals: {
        value: i.proposalsToDistinct,
        threshold: th.proposals,
        state: p,
      },
    },
  };
}

/** Поисковый сигнал D90 (ТЗ §16): неполные данные — «неопределённо». */
export function searchSignalD90(
  i: { indexedPages: number | null; pagesWithClicks28d: number | null },
  th: { indexedPages: number; pagesWithClicks28d: number },
): {
  verdict: Verdict;
  parts: { indexedPages: Part; pagesWithClicks28d: Part };
} {
  const a = part(i.indexedPages, th.indexedPages);
  const b = part(i.pagesWithClicks28d, th.pagesWithClicks28d);
  return {
    verdict: verdictOf([a, b]),
    parts: { indexedPages: a, pagesWithClicks28d: b },
  };
}

/**
 * Нижняя граница выборки для заключения (AT-F17-02: «одна заявка — система
 * не объявляет победителя»): даже если порог эксперимента ниже (заморожен
 * до исправления схемы параметра), «подтверждено/не подтверждено» по одной
 * заявке невозможно. 2 — наименьшая выборка, которая уже не «одна заявка»;
 * умолчание порога (5, Р-PUB-30) выше.
 */
export const MIN_SAMPLE_FLOOR = 2;

/**
 * F17 (AT-F17-02, ТЗ §23): заключение «подтверждено/не подтверждено»
 * допустимо только при закрытом окне и выборке ≥ max(`minSampleForConclusion`
 * замороженных порогов, `MIN_SAMPLE_FLOOR`); иначе — только «невизначено».
 * Победителя по одной заявке система не объявляет.
 */
export function experimentConclusionAllowed(i: {
  windowClosed: boolean;
  qualifiedUnique: number;
  minSample: number;
}): 'any' | 'inconclusive_only' {
  return i.windowClosed &&
    i.qualifiedUnique >= Math.max(i.minSample, MIN_SAMPLE_FLOOR)
    ? 'any'
    : 'inconclusive_only';
}

// ── Выручка (AT-CORE-24) ─────────────────────────────────────────────────

export interface PaymentIn {
  id: string;
  prospectId: string;
  leadId: string | null;
  recordType: 'payment_received' | 'refund' | 'contract_signed';
  payerKind: 'external' | 'internal' | 'test' | 'self';
  amountMinor: Minor;
  currency: string;
  status: 'pending' | 'confirmed' | 'refunded' | 'cancelled';
  occurredAt: Date;
  confirmedAt: Date | null;
  isNewCustomer: 'yes' | 'no' | 'unknown';
  /** `refund:<paymentId>` — запись возврата P-D (связь с оплатой). */
  paymentRef?: string;
}

/**
 * Возврат полученной оплаты (`confirmed → refunded`, P-D) пишет запись
 * `refund` с этим `paymentRef` и моментом возврата в `confirmedAt` —
 * единое правило P-D/P-E (аудит P-E S1-3): выручка и CAC знают, КОГДА
 * оплату вернули.
 */
export const AUTO_REFUND_REF_PREFIX = 'refund:';
export function autoRefundRef(paymentId: string): string {
  return `${AUTO_REFUND_REF_PREFIX}${paymentId}`;
}

/** Оплата получена на `at`: подтверждена до `at` (в т. ч. позже возвращённая). */
export function paymentConfirmedAt(p: PaymentIn, at: Date): boolean {
  return (
    (p.status === 'confirmed' || p.status === 'refunded') &&
    p.confirmedAt !== null &&
    p.confirmedAt.getTime() <= at.getTime()
  );
}

/**
 * Момент возврата полученной оплаты: запись `refund:<id>` (P-D) — её
 * `confirmedAt`; статус `refunded` без такой записи (данные до правила) —
 * момент неизвестен, считается возвращённой с момента подтверждения
 * (консервативно: ни выручкой, ни оплатой CAC она не была). null — не
 * возвращена.
 */
export function paymentRefundedAt(
  p: PaymentIn,
  autoRefunds: ReadonlyMap<string, PaymentIn>,
): Date | null {
  if (p.status !== 'refunded') return null;
  const r = autoRefunds.get(p.id);
  return r?.confirmedAt ?? p.confirmedAt;
}

/** Автоматические записи возврата по id исходной оплаты. */
export function autoRefundsOf(
  payments: readonly PaymentIn[],
): Map<string, PaymentIn> {
  const out = new Map<string, PaymentIn>();
  for (const r of payments) {
    if (r.recordType !== 'refund' || r.status !== 'confirmed') continue;
    if (!r.paymentRef?.startsWith(AUTO_REFUND_REF_PREFIX)) continue;
    out.set(r.paymentRef.slice(AUTO_REFUND_REF_PREFIX.length), r);
  }
  return out;
}

/** Полученная и НЕ возвращённая на `at` оплата (CAC, «оплативший»). */
export function paymentActiveAt(
  p: PaymentIn,
  at: Date,
  autoRefunds: ReadonlyMap<string, PaymentIn>,
): boolean {
  if (p.recordType !== 'payment_received' || !paymentConfirmedAt(p, at))
    return false;
  const back = paymentRefundedAt(p, autoRefunds);
  return !back || back.getTime() > at.getTime();
}

/**
 * Выручка и коммерческое подтверждение (ТЗ §16, §9 «Payment»): только
 * внешние подтверждённые `payment_received` минус подтверждённые внешние
 * `refund` (в т. ч. запись возврата P-D); статус `refunded` без записи —
 * возврат с момента подтверждения. Внутренние, тестовые и «свои» оплаты, а
 * также оплаты проспекта, который НА СНИМКЕ не внешний (позже помечен
 * командой/партнёром, аудит P-E S3-7), — не выручка и не CAC (считаются
 * отдельно). Договор — не выручка.
 */
export function revenueSummary(
  payments: readonly PaymentIn[],
  at: Date,
  isExternal: (prospectId: string) => boolean = () => true,
): {
  byCurrency: Record<
    string,
    { receivedMinor: Minor; refundedMinor: Minor; netMinor: Minor }
  >;
  externalPayingProspects: number;
  contractsSigned: number;
  excludedNonExternal: number;
  commercialValidation: 'confirmed' | 'not_confirmed';
} {
  const byCurrency: Record<
    string,
    { receivedMinor: Minor; refundedMinor: Minor; netMinor: Minor }
  > = {};
  const autoRefunds = autoRefundsOf(payments);
  // Оплативший — проспект с положительной внешней нетто-оплатой (полный
  // возврат снимает факт покупки).
  const net = new Map<string, Minor>();
  let contracts = 0;
  let excluded = 0;
  const bucket = (currency: string) =>
    (byCurrency[currency] ??= {
      receivedMinor: 0n,
      refundedMinor: 0n,
      netMinor: 0n,
    });
  const refund = (p: PaymentIn) => {
    const c = bucket(p.currency);
    c.refundedMinor += p.amountMinor;
    net.set(p.prospectId, (net.get(p.prospectId) ?? 0n) - p.amountMinor);
    c.netMinor = c.receivedMinor - c.refundedMinor;
  };
  for (const p of payments) {
    if (!paymentConfirmedAt(p, at)) continue;
    if (p.payerKind !== 'external' || !isExternal(p.prospectId)) {
      excluded++;
      continue;
    }
    const c = bucket(p.currency);
    if (p.recordType === 'payment_received') {
      c.receivedMinor += p.amountMinor;
      net.set(p.prospectId, (net.get(p.prospectId) ?? 0n) + p.amountMinor);
      c.netMinor = c.receivedMinor - c.refundedMinor;
      // Возврат статусом без записи: момент неизвестен — с подтверждения.
      if (p.status === 'refunded' && !autoRefunds.has(p.id)) refund(p);
    } else if (p.recordType === 'refund') {
      refund(p);
    } else {
      contracts++;
    }
  }
  const paying = [...net.values()].filter((v) => v > 0n).length;
  return {
    byCurrency,
    externalPayingProspects: paying,
    contractsSigned: contracts,
    excludedNonExternal: excluded,
    commercialValidation: paying > 0 ? 'confirmed' : 'not_confirmed',
  };
}
