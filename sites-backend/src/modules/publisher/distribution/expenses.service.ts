/**
 * AI Publisher, P-C — обязательства и записи движения денег (проектный
 * документ §6.4, §7.3, §8.2; ТЗ §17; AT-CORE-15, AT-CORE-17, AT-F12-01/02).
 *
 *  - расход `tools|other` — гейт `spend` (в т. ч. до D0, аудит P2-3) и
 *    функция `pub_budget_commit_tools`;
 *  - запись `pay` (confirmed | pending | unknown): confirmed переносит
 *    обязательство в net_paid, не вычитая второй раз; pending/unknown
 *    удерживают обязательство и требуют сверки — повтор оплаты и заказа
 *    отвергается `PUB_RECONCILE_REQUIRED`; оплата закупки — под гейтом
 *    `purchases` (§10), но СНАЧАЛА проверяется сверка;
 *  - `refund`: confirmed — деньги вернулись (net_paid ↓); pending —
 *    обещанный возврат (только запись, деньги не двигает);
 *  - `deliver` — оказано (экономическая стоимость; delivered_unpaid ⊆ open);
 *  - `adjust`: отрицательная — освобождение (по закупке — только
 *    отменённой/отклонённой: живую меняет новая цена и повторное
 *    согласование); положительная по закупке — только с новым
 *    согласованием purchase (`PUB_APPROVAL_REQUIRED`); при pending|unknown
 *    оплате — `PUB_RECONCILE_REQUIRED` (S1-1);
 *  - `cancel` — для tools/other (закупку отменяет машина закупки);
 *  - сверка pending|unknown → confirmed|void ответственным с документом.
 * Движение — только функциями `sites.pub_budget_*` (счётчики сверяются в
 * каждой).
 */
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { ProductCtx } from '../contracts/common';
import type {
  ExpenseEntryView,
  ExpenseView,
} from '../contracts/distribution-api';
import { PubError, validationError } from '../core/errors';
import { convertMinor } from '../core/money';
import { PubPorts, type PubTx } from '../core/ports';
import { budgetFn } from './budget-fn';
import {
  deliveredUnpaid,
  openCommitment,
  paymentStatusOf,
} from './budget-math';
import { BudgetService, expenseAmountsOf } from './budget.service';
import { Fields, parseFx, type Body } from './input';
import { priceSnapshotHash } from './approvals-purchase.service';
import {
  PRICE_BOUND_STATUSES,
  assertPriceApproved,
  refreshPaymentStatus,
  type OpResult,
  type Step,
} from './placements.service';

type ExpenseRow = Prisma.PubExpenseGetPayload<object>;
type EntryRow = Prisma.PubExpenseEntryGetPayload<object>;

const s = (v: bigint) => v.toString();

export function entryView(e: EntryRow): ExpenseEntryView {
  return {
    id: e.id,
    kind: e.kind as ExpenseEntryView['kind'],
    amountMinor: s(e.amountMinor),
    status: e.status as ExpenseEntryView['status'],
    externalRef: e.externalRef,
    sourceDocument: e.sourceDocument,
    note: e.note,
    occurredAt: e.occurredAt.toISOString(),
    confirmedAt: e.confirmedAt?.toISOString() ?? null,
    confirmedBy: e.confirmedBy,
    createdBy: e.createdBy,
  };
}

export function expenseView(
  e: ExpenseRow,
  entries: EntryRow[],
  withEntries: boolean,
): ExpenseView {
  const amounts = expenseAmountsOf(e);
  const pay = paymentStatusOf(
    amounts,
    entries
      .filter((x) => x.kind === 'pay')
      .map((x) => ({ status: x.status as 'confirmed' })),
  );
  return {
    id: e.id,
    category: e.category as ExpenseView['category'],
    description: e.description,
    placementId: e.placementId,
    amountTotalMinor: s(e.amountTotalMinor),
    paidMinor: s(e.paidMinor),
    refundedMinor: s(e.refundedMinor),
    cancelledMinor: s(e.cancelledMinor),
    deliveredMinor: s(e.deliveredMinor),
    openCommitmentMinor: s(openCommitment(amounts)),
    deliveredUnpaidMinor: s(deliveredUnpaid(amounts)),
    currency: e.currency,
    orig:
      e.origCurrency &&
      e.origAmountMinor !== null &&
      e.fxRate &&
      e.fxSource &&
      e.fxAt
        ? {
            currency: e.origCurrency,
            amountMinor: s(e.origAmountMinor),
            fxRate: e.fxRate.toString(),
            fxSource: e.fxSource,
            fxAt: e.fxAt.toISOString(),
          }
        : null,
    sourceDocument: e.sourceDocument,
    reconcileRequired: e.reconcileRequired,
    paymentStatus: pay.status,
    paymentPartial: pay.partial,
    status: e.status as ExpenseView['status'],
    ...(withEntries ? { entries: entries.map(entryView) } : {}),
    revision: e.revision,
  };
}

@Injectable()
export class ExpensesService {
  constructor(
    private readonly ports: PubPorts,
    private readonly budget: BudgetService,
  ) {}

  async row(tx: PubTx, productId: string, id: string): Promise<ExpenseRow> {
    const e = await tx.pubExpense.findFirst({ where: { id, productId } });
    if (!e) throw new PubError('PUB_NOT_FOUND');
    return e;
  }

  async view(tx: PubTx, productId: string, id: string): Promise<ExpenseView> {
    const e = await this.row(tx, productId, id);
    const entries = await tx.pubExpenseEntry.findMany({
      where: { expenseId: id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return expenseView(e, entries, true);
  }

  async list(
    tx: PubTx,
    productId: string,
    q: { category?: string; status?: string; before?: string; limit: number },
  ): Promise<ExpenseView[]> {
    const rows = await tx.pubExpense.findMany({
      where: {
        productId,
        ...(q.category ? { category: q.category } : {}),
        ...(q.status ? { status: q.status } : {}),
        ...(q.before ? { id: { lt: q.before } } : {}),
      },
      orderBy: { id: 'desc' },
      take: q.limit,
    });
    const entries = await tx.pubExpenseEntry.findMany({
      where: { expenseId: { in: rows.map((r) => r.id) }, kind: 'pay' },
    });
    return rows.map((r) =>
      expenseView(
        r,
        entries.filter((x) => x.expenseId === r.id),
        false,
      ),
    );
  }

  // ── Расход tools|other (гейт spend) ────────────────────────────────────

  async create(
    tx: PubTx,
    product: ProductCtx,
    step: Step,
    b: Body,
    opKey: string,
  ): Promise<OpResult<ExpenseView>> {
    const f = new Fields();
    const category = f.oneOf(b, 'category', ['tools', 'other'] as const);
    const description = f.str(b, 'description', 2000);
    const sourceDocument = f.str(b, 'sourceDocument', 2000, { optional: true });
    const amountRaw = b.amount;
    if (!amountRaw || typeof amountRaw !== 'object') {
      f.add('amount', 'required');
    }
    const ab = (amountRaw ?? {}) as Body;
    const currency = amountRaw ? f.currency(ab, 'currency') : null;
    const minor = amountRaw ? f.minor(ab, 'minor', { positive: true }) : null;
    const fx = parseFx(f, b.fx);
    f.done();
    if (!category || !description || !currency || minor === null) {
      throw validationError([{ field: '$', code: 'required' }]);
    }
    await this.ports
      .gates()
      .assertOpen(tx, product, 'spend', step.now, { category });
    const limit = await this.budget.limitRow(tx, product.id);
    if (!limit) {
      throw new PubError('PUB_GATE_CLOSED', {
        gate: 'spend',
        missing: [
          { kind: 'budget', key: 'pub_budget_limits', detail: 'not_built' },
        ],
      });
    }
    let amount = minor;
    let fxCols = {
      origCurrency: null as string | null,
      origAmountMinor: null as bigint | null,
      fxRate: null as string | null,
      fxSource: null as string | null,
      fxAt: null as Date | null,
    };
    if (currency !== limit.currency) {
      if (!fx) {
        throw new PubError('PUB_FX_REQUIRED', {
          currency,
          limitCurrency: limit.currency,
          missing: ['fx.rate', 'fx.source', 'fx.at'],
        });
      }
      amount = convertMinor(minor, fx.rate);
      fxCols = {
        origCurrency: currency,
        origAmountMinor: minor,
        fxRate: fx.rate,
        fxSource: fx.source,
        fxAt: fx.at,
      };
    }
    await this.precheck(tx, product.id, amount, category);
    const id = await budgetFn.commitTools(tx, product, {
      amount,
      category,
      description,
      fx: fxCols,
      sourceDocument,
      opKey,
      actor: step.actor,
    });
    if (!id) throw new Error('pub_budget_commit_tools: нет id');
    return {
      body: await this.view(tx, product.id, id),
      audit: [
        {
          objectType: 'expense',
          objectId: id,
          action: 'create',
          toStatus: 'open',
          meta: {
            category,
            amountMinor: Number(amount),
            currency: limit.currency,
          },
        },
      ],
    };
  }

  /** Причина отказа до атомарного вызова (после ошибки функции читать нельзя). */
  private async precheck(
    tx: PubTx,
    productId: string,
    amount: bigint,
    category: 'placements' | 'tools' | 'other',
  ): Promise<void> {
    if (await budgetFn.stopped(tx, productId)) {
      throw new PubError('PUB_BUDGET_STOPPED', { reason: 'reconcile' });
    }
    const limit = await this.budget.limitRow(tx, productId);
    if (!limit) return;
    const m = await this.budget.math(tx, productId, limit);
    if (m.stopped) {
      throw new PubError('PUB_BUDGET_STOPPED', {
        usageBp: m.usageBp,
        reason: 'stopped',
      });
    }
    const cat = category === 'placements' ? 'placements' : 'tools';
    if (m.available < amount || m.byCategory[cat].available < amount) {
      throw new PubError('PUB_BUDGET_INSUFFICIENT', {
        available: m.available.toString(),
        categoryAvailable: m.byCategory[cat].available.toString(),
        requested: amount.toString(),
        reason: m.available < amount ? 'insufficient' : 'category_cap',
      });
    }
  }

  // ── Записи движения ────────────────────────────────────────────────────

  async entry(
    tx: PubTx,
    product: ProductCtx,
    step: Step,
    expenseId: string,
    b: Body,
    opKey: string,
  ): Promise<OpResult<ExpenseView>> {
    const f = new Fields();
    const kind = f.oneOf(b, 'kind', [
      'pay',
      'refund',
      'deliver',
      'adjust',
      'cancel',
    ] as const);
    const amount = f.minor(b, 'amountMinor', {
      signed: kind === 'adjust',
      positive: kind !== 'adjust',
    });
    const status =
      b.status === undefined
        ? 'confirmed'
        : f.oneOf(b, 'status', ['confirmed', 'pending', 'unknown'] as const);
    const externalRef = f.str(b, 'externalRef', 200, {
      optional: true,
      pii: false,
    });
    const sourceDocument = f.str(b, 'sourceDocument', 2000, { optional: true });
    const note = f.str(b, 'note', 2000, { optional: true });
    const occurredAt = f.date(b, 'occurredAt', { optional: true }) ?? step.now;
    const approvalId = f.id(b, 'approvalId', { optional: true });
    f.done();
    if (!kind || amount === null || !status) {
      throw validationError([{ field: '$', code: 'required' }]);
    }
    if (kind === 'refund' && status === 'unknown') {
      throw validationError([{ field: 'status', code: 'enum' }]);
    }
    if (!['pay', 'refund'].includes(kind) && status !== 'confirmed') {
      throw validationError([{ field: 'status', code: 'enum' }]);
    }
    const e = await this.row(tx, product.id, expenseId);
    const placement = e.placementId
      ? await tx.pubPlacement.findFirst({
          where: { id: e.placementId, productId: product.id },
        })
      : null;
    const args = {
      expenseId,
      amount,
      externalRef,
      sourceDocument,
      note,
      occurredAt,
      opKey,
      actor: step.actor,
    };
    let entryId: string | null = null;
    switch (kind) {
      case 'pay': {
        if (e.category === 'placements') {
          // Сверка раньше гейта: повтор неизвестной оплаты — RECONCILE (AT-CORE-15).
          const unsettled = await tx.pubExpenseEntry.count({
            where: {
              expenseId,
              kind: 'pay',
              status: { in: ['pending', 'unknown'] },
            },
          });
          if (unsettled > 0) {
            throw new PubError('PUB_RECONCILE_REQUIRED', { expenseId });
          }
          // Оплата живой закупки — только по согласованной текущей цене
          // (S0-1): после правки цены — повторное согласование.
          if (placement && PRICE_BOUND_STATUSES.includes(placement.status)) {
            await assertPriceApproved(tx, product.id, placement);
          }
          await this.ports
            .gates()
            .assertOpen(tx, product, 'purchases', step.now);
        }
        entryId = await budgetFn.pay(tx, product, {
          ...args,
          status: status as 'confirmed' | 'pending' | 'unknown',
        });
        break;
      }
      case 'refund':
        entryId = await budgetFn.refund(tx, product, {
          ...args,
          status: status as 'confirmed' | 'pending',
        });
        break;
      case 'deliver':
        entryId = await budgetFn.deliver(tx, product, args);
        break;
      case 'cancel':
        if (e.category === 'placements') {
          throw validationError([
            { field: 'kind', code: 'use_placement_cancel' },
          ]);
        }
        entryId = await budgetFn.cancel(tx, product, args);
        break;
      case 'adjust': {
        if (!note) throw validationError([{ field: 'note', code: 'required' }]);
        // Неурегулированная оплата удерживает обязательство (AT-CORE-15, S1-1):
        // корректировать его до сверки нельзя (функция проверяет то же).
        const unsettled = await tx.pubExpenseEntry.count({
          where: {
            expenseId,
            kind: 'pay',
            status: { in: ['pending', 'unknown'] },
          },
        });
        if (unsettled > 0) {
          throw new PubError('PUB_RECONCILE_REQUIRED', { expenseId });
        }
        // Снизить обязательство живой закупки — только через новую цену и
        // повторное согласование (S0-1/S1-1); маршрутом записей —
        // неотменённый остаток отменённой/отклонённой закупки (Р-PUB-C-20).
        if (
          amount < 0n &&
          placement &&
          !['cancelled', 'rejected'].includes(placement.status)
        ) {
          throw validationError([
            { field: 'amountMinor', code: 'placement_active' },
          ]);
        }
        let snap: string | null = null;
        if (amount > 0n) {
          if (e.category === 'placements') {
            if (!approvalId) {
              throw new PubError('PUB_APPROVAL_REQUIRED', {
                reason: 'positive_adjust_needs_purchase_approval',
              });
            }
            if (!placement) throw new PubError('PUB_NOT_FOUND');
            snap = priceSnapshotHash(placement);
            await this.ports
              .gates()
              .assertOpen(tx, product, 'purchases', step.now);
          } else {
            await this.ports
              .gates()
              .assertOpen(tx, product, 'spend', step.now, {
                category: e.category as 'tools' | 'other',
              });
          }
          await this.precheck(
            tx,
            product.id,
            amount,
            e.category as 'placements' | 'tools' | 'other',
          );
        }
        entryId = await budgetFn.adjust(tx, product, {
          ...args,
          approvalId,
          priceSnapshotHash: snap,
        });
        break;
      }
    }
    if (e.placementId) await refreshPaymentStatus(tx, e.placementId);
    return {
      body: await this.view(tx, product.id, expenseId),
      audit: [
        {
          objectType: 'expense_entry',
          objectId: entryId ?? expenseId,
          action: 'create',
          toStatus: status,
          meta: {
            expenseId,
            kind,
            amountMinor: Number(amount),
            ...(externalRef ? { externalRef } : {}),
            ...(approvalId ? { approvalId } : {}),
          },
        },
      ],
    };
  }

  /** Сверка записи pending|unknown → confirmed|void с документом (AT-CORE-15). */
  async reconcile(
    tx: PubTx,
    product: ProductCtx,
    step: Step,
    expenseId: string,
    entryId: string,
    b: Body,
  ): Promise<OpResult<ExpenseView>> {
    const f = new Fields();
    const status = f.oneOf(b, 'status', ['confirmed', 'void'] as const);
    const document = f.str(b, 'document', 2000);
    f.done();
    if (!status || !document) {
      throw validationError([{ field: '$', code: 'required' }]);
    }
    const en = await tx.pubExpenseEntry.findFirst({
      where: { id: entryId, expenseId, productId: product.id },
      select: { id: true, status: true, kind: true },
    });
    if (!en) throw new PubError('PUB_NOT_FOUND');
    await budgetFn.reconcile(tx, product, {
      entryId,
      status,
      actor: step.actor,
    });
    const e = await this.row(tx, product.id, expenseId);
    if (e.placementId) await refreshPaymentStatus(tx, e.placementId);
    return {
      body: await this.view(tx, product.id, expenseId),
      audit: [
        {
          objectType: 'expense_entry',
          objectId: entryId,
          action: 'resolve',
          fromStatus: en.status,
          toStatus: status,
          meta: { expenseId, kind: en.kind, documentRef: document },
        },
      ],
    };
  }
}
