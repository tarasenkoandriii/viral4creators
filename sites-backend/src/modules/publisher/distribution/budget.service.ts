/**
 * AI Publisher, P-C — строка лимита и снимок бюджета (проектный документ
 * §6.4, §8.2, §9.2, §16.0; ТЗ §17):
 *  - `BudgetLimitPort.applyParameters` — сборка `pub_budget_limits` из
 *    действующих значений `budget_total`, `budget_split`, `per_purchase_max`
 *    (± Σ переводов резерва; `paramVersion` = сумма версий, Р-PUB-A1-5).
 *    Несогласованные значения (`budgetConsistencyIssues`) — лимит НЕ
 *    собирается и исключение НЕ бросается (контракт P-A1): решение по
 *    параметру проходит, гейт видит `budget/stale|inconsistent`;
 *  - `BudgetReadPort.snapshot` — §9.2 по головам обязательств (на дату —
 *    по подтверждённым записям);
 *  - экран бюджета и перевод защищённого резерва (решение владельца).
 */
import { Injectable } from '@nestjs/common';
import type { MinorJson } from '../contracts/common';
import type { BudgetView } from '../contracts/distribution-api';
import {
  BUDGET_LIMIT_PARAMETER_KEYS,
  budgetParamVersion,
  type ParameterValues,
} from '../contracts/parameters';
import { PubError } from '../core/errors';
import { budgetConsistencyIssues } from '../core/parameter-schemas';
import type {
  BudgetLimitPort,
  BudgetReadPort,
  BudgetSnapshot,
  ProductRef,
  PubTx,
} from '../core/ports';
import {
  budgetSnapshot,
  cashVsEconomic,
  expensesFromEntries,
  type BudgetSnapshotMath,
  type EntryAmount,
  type ExpenseAmounts,
  type ExpenseCategory,
} from './budget-math';
import { budgetFn } from './budget-fn';

export const BUDGET_LIMIT_ACTOR = 'system:budget-limit';

const j = (v: bigint): MinorJson => v.toString();

export interface LimitRow {
  id: string;
  currency: string;
  totalLimitMinor: bigint;
  placementsLimitMinor: bigint;
  toolsLimitMinor: bigint;
  protectedReserveMinor: bigint;
  perPurchaseMaxMinor: bigint;
  netPaidMinor: bigint;
  openCommitMinor: bigint;
  usedPlacementsMinor: bigint;
  usedToolsMinor: bigint;
  warnRatioBp: number;
  paramVersion: number;
}

export function expenseAmountsOf(e: {
  amountTotalMinor: bigint;
  paidMinor: bigint;
  refundedMinor: bigint;
  cancelledMinor: bigint;
  deliveredMinor: bigint;
  category: string;
}): ExpenseAmounts {
  return {
    amountTotal: e.amountTotalMinor,
    paid: e.paidMinor,
    refunded: e.refundedMinor,
    cancelled: e.cancelledMinor,
    delivered: e.deliveredMinor,
    category: e.category as ExpenseCategory,
  };
}

export function snapshotFromMath(
  currency: string,
  s: BudgetSnapshotMath,
): BudgetSnapshot {
  return {
    currency,
    total: s.total,
    netPaid: s.netPaid,
    openCommitment: s.openCommitment,
    deliveredUnpaid: s.deliveredUnpaid,
    protectedReserve: s.protectedReserve,
    available: s.available,
    usageBp: s.usageBp,
    warn: s.warn,
    stopped: s.stopped,
    byCategory: s.byCategory,
  };
}

@Injectable()
export class BudgetService implements BudgetLimitPort, BudgetReadPort {
  // ── BudgetLimitPort ─────────────────────────────────────────────────────

  async applyParameters(tx: PubTx, product: ProductRef): Promise<void> {
    await this.build(tx, product, BUDGET_LIMIT_ACTOR);
  }

  /** Собрать строку лимита; false — не собрана (значения не сходятся). */
  async build(tx: PubTx, product: ProductRef, actor: string): Promise<boolean> {
    const rows = await tx.pubParameter.findMany({
      where: {
        productId: product.id,
        key: {
          in: [...BUDGET_LIMIT_PARAMETER_KEYS],
        },
      },
      select: { key: true, value: true, version: true },
    });
    const byKey = new Map(rows.map((r) => [r.key, r]));
    const total = byKey.get('budget_total')?.value as
      ParameterValues['budget_total'] | undefined;
    const split = byKey.get('budget_split')?.value as
      ParameterValues['budget_split'] | undefined;
    const per = byKey.get('per_purchase_max')?.value as
      ParameterValues['per_purchase_max'] | undefined;
    if (!total || !split || !per) return false;
    const issues = budgetConsistencyIssues({
      budget_total: total,
      budget_split: split,
      per_purchase_max: per,
    });
    if (issues.length) return false;
    const id = await budgetFn.applyLimits(tx, product, {
      currency: total.currency,
      total: BigInt(total.amountMinor),
      placements: BigInt(split.placementsMinor),
      tools: BigInt(split.toolsMinor),
      reserve: BigInt(split.reserveMinor),
      perPurchase: BigInt(per.amountMinor),
      paramVersion: budgetParamVersion(
        Object.fromEntries(
          BUDGET_LIMIT_PARAMETER_KEYS.map((k) => [
            k,
            byKey.get(k)?.version ?? 0,
          ]),
        ),
      ),
      actor,
    });
    return id !== null;
  }

  // ── BudgetReadPort ──────────────────────────────────────────────────────

  async limitRow(tx: PubTx, productId: string): Promise<LimitRow | null> {
    return tx.pubBudgetLimit.findFirst({
      where: { productId },
      select: {
        id: true,
        currency: true,
        totalLimitMinor: true,
        placementsLimitMinor: true,
        toolsLimitMinor: true,
        protectedReserveMinor: true,
        perPurchaseMaxMinor: true,
        netPaidMinor: true,
        openCommitMinor: true,
        usedPlacementsMinor: true,
        usedToolsMinor: true,
        warnRatioBp: true,
        paramVersion: true,
      },
    });
  }

  async entriesOf(tx: PubTx, productId: string): Promise<EntryAmount[]> {
    const rows = await tx.pubExpenseEntry.findMany({
      where: { productId },
      select: {
        expenseId: true,
        kind: true,
        amountMinor: true,
        status: true,
        confirmedAt: true,
      },
    });
    return rows.map((r) => ({
      expenseId: r.expenseId,
      kind: r.kind as EntryAmount['kind'],
      amount: r.amountMinor,
      status: r.status as EntryAmount['status'],
      confirmedAt: r.confirmedAt,
    }));
  }

  async math(
    tx: PubTx,
    productId: string,
    limit: LimitRow,
    at?: Date,
  ): Promise<BudgetSnapshotMath> {
    const heads = await tx.pubExpense.findMany({
      where: { productId },
      select: {
        id: true,
        category: true,
        amountTotalMinor: true,
        paidMinor: true,
        refundedMinor: true,
        cancelledMinor: true,
        deliveredMinor: true,
      },
    });
    const expenses = at
      ? [
          ...expensesFromEntries(
            heads.map((h) => ({
              id: h.id,
              category: h.category as ExpenseCategory,
            })),
            await this.entriesOf(tx, productId),
            at,
          ).values(),
        ]
      : heads.map(expenseAmountsOf);
    return budgetSnapshot(
      {
        total: limit.totalLimitMinor,
        protectedReserve: limit.protectedReserveMinor,
        byCategory: {
          placements: limit.placementsLimitMinor,
          tools: limit.toolsLimitMinor,
        },
        perPurchaseMax: limit.perPurchaseMaxMinor,
        warnRatioBp: limit.warnRatioBp,
      },
      expenses,
    );
  }

  async snapshot(
    tx: PubTx,
    product: ProductRef,
    at?: Date,
  ): Promise<BudgetSnapshot> {
    const limit = await this.limitRow(tx, product.id);
    if (!limit) {
      throw new PubError('PUB_GATE_CLOSED', {
        gate: 'spend',
        missing: [
          { kind: 'budget', key: 'pub_budget_limits', detail: 'not_built' },
        ],
      });
    }
    return snapshotFromMath(
      limit.currency,
      await this.math(tx, product.id, limit, at),
    );
  }

  // ── Экран «Бюджет» (§14.1) ──────────────────────────────────────────────

  async view(tx: PubTx, productId: string): Promise<BudgetView> {
    const limit = await this.limitRow(tx, productId);
    const empty = (): BudgetView['byCategory'] => ({
      placements: { used: '0', limit: '0', available: '0' },
      tools: { used: '0', limit: '0', available: '0' },
    });
    if (!limit) {
      return {
        built: false,
        currency: null,
        total: '0',
        netPaid: '0',
        openCommitment: '0',
        deliveredUnpaid: '0',
        protectedReserve: '0',
        available: '0',
        usageBp: 0,
        warn: false,
        stopped: false,
        reconcileStopped: false,
        perPurchaseMax: '0',
        byCategory: empty(),
        cash: { paid: '0', economicDelivered: '0', advances: '0' },
        warnings: ['stale_limit'],
        paramVersion: 0,
        reserveMoves: [],
      };
    }
    const s = await this.math(tx, productId, limit);
    const cash = cashVsEconomic(await this.entriesOf(tx, productId));
    const reconcileStopped = await budgetFn.stopped(tx, productId);
    const reconcileRequired =
      (await tx.pubExpense.count({
        where: { productId, reconcileRequired: true },
      })) > 0;
    const versions = await tx.pubParameter.findMany({
      where: { productId, key: { in: [...BUDGET_LIMIT_PARAMETER_KEYS] } },
      select: { key: true, version: true },
    });
    const stale =
      limit.paramVersion !==
      budgetParamVersion(
        Object.fromEntries(versions.map((v) => [v.key, v.version])),
      );
    const moves = await tx.pubReserveMove.findMany({
      where: { productId },
      orderBy: { movedAt: 'asc' },
      select: {
        id: true,
        toCategory: true,
        amountMinor: true,
        approvalId: true,
        movedAt: true,
      },
    });
    const warnings: BudgetView['warnings'] = [];
    if (s.warn && !s.stopped) warnings.push('warn_80');
    if (s.stopped) warnings.push('stopped_100');
    if (reconcileRequired) warnings.push('reconcile_required');
    if (reconcileStopped) warnings.push('reconcile_stopped');
    if (stale) warnings.push('stale_limit');
    return {
      built: true,
      currency: limit.currency,
      total: j(s.total),
      netPaid: j(s.netPaid),
      openCommitment: j(s.openCommitment),
      deliveredUnpaid: j(s.deliveredUnpaid),
      protectedReserve: j(s.protectedReserve),
      available: j(s.available),
      usageBp: s.usageBp,
      warn: s.warn,
      stopped: s.stopped,
      reconcileStopped,
      perPurchaseMax: j(s.perPurchaseMax),
      byCategory: {
        placements: {
          used: j(s.byCategory.placements.used),
          limit: j(s.byCategory.placements.limit),
          available: j(s.byCategory.placements.available),
        },
        tools: {
          used: j(s.byCategory.tools.used),
          limit: j(s.byCategory.tools.limit),
          available: j(s.byCategory.tools.available),
        },
      },
      cash: {
        paid: j(cash.cashPaid),
        economicDelivered: j(cash.economicDelivered),
        advances: j(cash.advances),
      },
      warnings,
      paramVersion: limit.paramVersion,
      reserveMoves: moves.map((m) => ({
        id: m.id,
        toCategory: m.toCategory as 'placements' | 'tools',
        amountMinor: j(m.amountMinor),
        approvalId: m.approvalId,
        movedAt: m.movedAt.toISOString(),
      })),
    };
  }
}
