/**
 * AI Publisher — бюджет как чистые функции (P-C, проектный документ §9.2;
 * ТЗ §17). Эталон для сверки счётчиков (`budget-reconcile`, снимок
 * `BudgetReadPort`) и для отчёта; сами счётчики меняют только SQL-функции
 * `sites.pub_budget_*` (§8.2).
 *
 *  - доступно = общий лимит − net_paid − open_commitment − защищённый резерв;
 *  - net_paid = Σ подтверждённых оплат − Σ подтверждённых возвратов;
 *  - open_commitment = Σ (обязательство − оплачено − отменено);
 *  - delivered_unpaid ⊆ open_commitment и второй раз не вычитается;
 *  - 80 % — предупреждение, 100 % — новые обязательства остановлены;
 *    база — (net_paid + open) / (лимит − защищённый резерв) (Р-PUB-8);
 *  - категория `other` учитывается в лимите `tools` (ТЗ §17).
 *
 * Чистый модуль: без Nest, базы и env; суммы — bigint (минимальные единицы).
 */
import type { Bp, Minor } from '../contracts/common';

export type ExpenseCategory = 'placements' | 'tools' | 'other';
export type LimitCategory = 'placements' | 'tools';

export interface ExpenseAmounts {
  amountTotal: Minor;
  paid: Minor;
  refunded: Minor;
  cancelled: Minor;
  delivered: Minor;
  category: ExpenseCategory;
}

export interface BudgetLimitInput {
  total: Minor;
  protectedReserve: Minor;
  byCategory: Record<LimitCategory, Minor>;
  perPurchaseMax: Minor;
  warnRatioBp: Bp;
}

export interface CategoryState {
  used: Minor;
  limit: Minor;
  available: Minor;
}

export interface BudgetSnapshotMath {
  total: Minor;
  netPaid: Minor;
  openCommitment: Minor;
  deliveredUnpaid: Minor;
  protectedReserve: Minor;
  available: Minor;
  usageBp: Bp;
  warn: boolean;
  stopped: boolean;
  perPurchaseMax: Minor;
  byCategory: Record<LimitCategory, CategoryState>;
}

export type ReserveRefusal =
  | 'insufficient'
  | 'category_cap'
  | 'per_purchase_cap'
  | 'purchases_disabled'
  | 'stopped';

const max0 = (v: Minor): Minor => (v > 0n ? v : 0n);
const min = (a: Minor, b: Minor): Minor => (a < b ? a : b);

export const limitCategoryOf = (c: ExpenseCategory): LimitCategory =>
  c === 'placements' ? 'placements' : 'tools';

/** Открытое обязательство: обязательство − оплачено − отменено (≥ 0). */
export function openCommitment(e: ExpenseAmounts): Minor {
  const v = e.amountTotal - e.paid - e.cancelled;
  if (v < 0n) {
    throw new RangeError(
      `openCommitment: paid + cancelled > amountTotal (${e.paid} + ${e.cancelled} > ${e.amountTotal})`,
    );
  }
  return v;
}

/**
 * Оказано, но не оплачено: max(0, min(delivered, total − cancelled) − paid).
 * Всегда ⊆ open_commitment (ТЗ §17: «не вычитается второй раз»).
 */
export function deliveredUnpaid(e: ExpenseAmounts): Minor {
  return max0(min(e.delivered, e.amountTotal - e.cancelled) - e.paid);
}

export function netPaid(es: readonly ExpenseAmounts[]): Minor {
  return es.reduce((s, e) => s + (e.paid - e.refunded), 0n);
}

/** Использовано в категории лимита = net_paid + open (= total − cancelled − refunded). */
export function usedOf(e: ExpenseAmounts): Minor {
  return e.paid - e.refunded + openCommitment(e);
}

/** Доля использования лимита в б.п. (округление вниз), без резерва в базе. */
export function usageBp(
  netPaidV: Minor,
  open: Minor,
  total: Minor,
  reserve: Minor,
): Bp {
  const base = total - reserve;
  if (base <= 0n) return netPaidV + open > 0n ? 10_000 : 0;
  const bp = ((netPaidV + open) * 10_000n) / base;
  return Number(bp > 1_000_000n ? 1_000_000n : bp);
}

export function budgetSnapshot(
  limit: BudgetLimitInput,
  es: readonly ExpenseAmounts[],
): BudgetSnapshotMath {
  const np = netPaid(es);
  const open = es.reduce((s, e) => s + openCommitment(e), 0n);
  const du = es.reduce((s, e) => s + deliveredUnpaid(e), 0n);
  const usage = usageBp(np, open, limit.total, limit.protectedReserve);
  const byCategory = {} as Record<LimitCategory, CategoryState>;
  for (const c of ['placements', 'tools'] as const) {
    const used = es
      .filter((e) => limitCategoryOf(e.category) === c)
      .reduce((s, e) => s + usedOf(e), 0n);
    const lim = limit.byCategory[c];
    byCategory[c] = { used, limit: lim, available: lim - used };
  }
  return {
    total: limit.total,
    netPaid: np,
    openCommitment: open,
    deliveredUnpaid: du,
    protectedReserve: limit.protectedReserve,
    available: limit.total - np - open - limit.protectedReserve,
    usageBp: usage,
    warn: usage >= limit.warnRatioBp,
    stopped: usage >= 10_000,
    perPurchaseMax: limit.perPurchaseMax,
    byCategory,
  };
}

/**
 * Можно ли новое обязательство (эталон условия `pub_budget_reserve` /
 * `pub_budget_commit_tools`; сервис уточняет им причину отказа).
 */
export function canReserve(
  s: BudgetSnapshotMath,
  amount: Minor,
  category: ExpenseCategory,
): { ok: true } | { ok: false; reason: ReserveRefusal } {
  if (amount <= 0n) throw new RangeError('canReserve: сумма ≤ 0');
  if (s.stopped) return { ok: false, reason: 'stopped' };
  // `per_purchase_max = 0` — закупки отключены (не «мало бюджета»).
  if (category === 'placements' && s.perPurchaseMax === 0n) {
    return { ok: false, reason: 'purchases_disabled' };
  }
  if (category === 'placements' && amount > s.perPurchaseMax) {
    return { ok: false, reason: 'per_purchase_cap' };
  }
  if (s.available < amount) return { ok: false, reason: 'insufficient' };
  if (s.byCategory[limitCategoryOf(category)].available < amount) {
    return { ok: false, reason: 'category_cap' };
  }
  return { ok: true };
}

/** Запись движения для кассового/экономического среза. */
export interface EntryAmount {
  expenseId: string;
  kind: 'commit' | 'pay' | 'refund' | 'cancel' | 'deliver' | 'adjust';
  amount: Minor;
  status: 'confirmed' | 'pending' | 'unknown' | 'void';
  /** Для кассовых сумм на дату — время подтверждения. */
  confirmedAt: Date | null;
}

/**
 * Кассовое и экономическое (ТЗ §15, §17 «денежная сверка и экономическая
 * стоимость ведутся отдельно»): кассовые = Σ оплат − Σ возвратов
 * (подтверждённых к `at`), экономические = оказано, авансы = оплачено −
 * оказано (≥ 0). Вектор AI-07: оказано 1 500, оплачено 1 200 → 1 500 и 1 200.
 */
export function cashVsEconomic(
  entries: readonly EntryAmount[],
  at?: Date,
): { cashPaid: Minor; economicDelivered: Minor; advances: Minor } {
  const ok = (e: EntryAmount) =>
    e.status === 'confirmed' &&
    (!at || (e.confirmedAt !== null && e.confirmedAt <= at));
  const sum = (kind: EntryAmount['kind']) =>
    entries
      .filter((e) => e.kind === kind && ok(e))
      .reduce((s, e) => s + e.amount, 0n);
  const cashPaid = sum('pay') - sum('refund');
  const economicDelivered = sum('deliver');
  return {
    cashPaid,
    economicDelivered,
    advances: max0(cashPaid - economicDelivered),
  };
}

/** Головы обязательств из подтверждённых записей (эталон для сверки и `at`). */
export function expensesFromEntries(
  heads: ReadonlyArray<{ id: string; category: ExpenseCategory }>,
  entries: readonly EntryAmount[],
  at?: Date,
): Map<string, ExpenseAmounts> {
  const out = new Map<string, ExpenseAmounts>();
  for (const h of heads) {
    out.set(h.id, {
      amountTotal: 0n,
      paid: 0n,
      refunded: 0n,
      cancelled: 0n,
      delivered: 0n,
      category: h.category,
    });
  }
  for (const e of entries) {
    if (e.status !== 'confirmed') continue;
    if (at && (e.confirmedAt === null || e.confirmedAt > at)) continue;
    const x = out.get(e.expenseId);
    if (!x) continue;
    switch (e.kind) {
      case 'commit':
      case 'adjust':
        x.amountTotal += e.amount;
        break;
      case 'pay':
        x.paid += e.amount;
        break;
      case 'refund':
        x.refunded += e.amount;
        break;
      case 'cancel':
        x.cancelled += e.amount;
        break;
      case 'deliver':
        x.delivered += e.amount;
        break;
    }
  }
  return out;
}

/** Счётчики строки лимита, которые должны получиться из обязательств. */
export function expectedCounters(es: readonly ExpenseAmounts[]): {
  netPaid: Minor;
  openCommit: Minor;
  usedPlacements: Minor;
  usedTools: Minor;
} {
  let usedPlacements = 0n;
  let usedTools = 0n;
  for (const e of es) {
    if (limitCategoryOf(e.category) === 'placements')
      usedPlacements += usedOf(e);
    else usedTools += usedOf(e);
  }
  return {
    netPaid: netPaid(es),
    openCommit: es.reduce((s, e) => s + openCommitment(e), 0n),
    usedPlacements,
    usedTools,
  };
}

/**
 * Статус оплаты закупки (§6.4, §7.3; аудит P3-8) — выводится из записей:
 *  - `unknown` — есть запись `pay` со статусом unknown;
 *  - `pending` — есть `pay` pending, ИЛИ оплачено частично (признак partial);
 *  - `refunded` — подтверждённый возврат всей оплаченной суммы;
 *  - `paid` — net оплачено = обязательство − отменено;
 *  - `unpaid` — иначе.
 */
export function paymentStatusOf(
  e: ExpenseAmounts,
  payEntries: ReadonlyArray<{ status: EntryAmount['status'] }>,
): {
  status: 'unpaid' | 'pending' | 'paid' | 'refunded' | 'unknown';
  partial: boolean;
} {
  if (payEntries.some((x) => x.status === 'unknown')) {
    return { status: 'unknown', partial: false };
  }
  const due = e.amountTotal - e.cancelled;
  const net = e.paid - e.refunded;
  if (e.paid > 0n && e.refunded >= e.paid) {
    return { status: 'refunded', partial: false };
  }
  if (payEntries.some((x) => x.status === 'pending')) {
    return { status: 'pending', partial: net > 0n && net < due };
  }
  if (net > 0n && net >= due) return { status: 'paid', partial: false };
  if (net > 0n) return { status: 'pending', partial: true };
  return { status: 'unpaid', partial: false };
}
