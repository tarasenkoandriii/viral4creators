/**
 * AI Publisher, P-C — ежедневная сверка счётчиков бюджета `budget-reconcile`
 * (проектный документ §6.4, §8.2, §15.1; решение координатора по
 * Р-PUB-A0-2: вторая линия после сверки внутри функций `pub_budget_*`).
 *
 * По каждому продукту (`kind=working|test`, активному) со строкой лимита:
 * счётчики `pub_budget_limits` сравниваются с эталоном из записей двумя
 * независимыми способами — SQL `pub_budget_expected` и чистыми функциями
 * `budget-math` (так ловится и запись мимо функций, и ошибка самой функции).
 * Расхождение — задача владельцу (`budget_limit`, `triggerRef =
 * budget-reconcile:<дата Kyiv>`, critical) и остановка новых обязательств:
 * пока задача открыта, `pub_budget_reserve/commit_tools/adjust(+)` отвечают
 * `PUB_BUDGET_STOPPED` (снимает владелец, решив задачу после разбора).
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { SitesDb } from '../../../prisma/sites-db.service';
import { PubContribution } from '../core/contributions';
import { kyivDateOf } from '../core/kyiv-time';
import {
  PubPorts,
  type CronJob,
  type CronResult,
  type PubCronContext,
  type PubTx,
} from '../core/ports';
import { budgetFn } from './budget-fn';
import {
  expectedCounters,
  expensesFromEntries,
  type ExpenseCategory,
} from './budget-math';
import { BudgetService } from './budget.service';

export interface ReconcileOutcome {
  productId: string;
  ok: boolean;
  diff: Record<string, string>;
}

@Injectable()
@PubContribution('cron-job')
export class BudgetReconcileJob implements CronJob {
  readonly key = 'budget-reconcile';
  readonly schedule = 'daily' as const;

  constructor(
    private readonly db: SitesDb,
    private readonly ports: PubPorts,
    private readonly budget: BudgetService,
  ) {}

  async run(ctx: PubCronContext): Promise<CronResult> {
    const system = this.db.system(
      'крон publisher budget-reconcile: счётчики бюджета всех кабинетов',
    );
    const scope = ctx.scope
      ? Prisma.sql`AND p."siteId" = ANY(${ctx.scope.siteIds}::text[])`
      : Prisma.empty;
    const products = await system.$queryRaw<
      Array<{ id: string; accountId: string }>
    >`
      SELECT p."id", p."accountId"
        FROM "sites"."pub_products" p
        JOIN "sites"."pub_budget_limits" bl ON bl."productId" = p."id"
       WHERE p."kind" IN ('working', 'test') AND p."status" = 'active' ${scope}
       ORDER BY p."id"`;
    let processed = 0;
    let mismatches = 0;
    for (const p of products) {
      if (Date.now() > ctx.deadline.getTime()) break;
      const r = await this.db
        .forAccount(p.accountId)
        .$transaction((tx) => this.reconcileOne(tx, p, ctx.now));
      processed++;
      if (!r.ok) mismatches++;
    }
    return { processed, details: { checked: processed, mismatches } };
  }

  async reconcileOne(
    tx: PubTx,
    product: { id: string; accountId: string },
    now: Date,
  ): Promise<ReconcileOutcome> {
    // Один согласованный снимок (S2-1): строка лимита — FOR SHARE первым
    // оператором. Денежные функции берут её FOR UPDATE первыми, поэтому
    // идущая оплата/отмена завершается до сверки, а новая ждёт её конца;
    // строка лимита, головы и записи ниже читаются без промежуточных
    // фиксаций (иначе — ложное расхождение и остановка закупок).
    await tx.$queryRaw`
      SELECT 1 FROM "sites"."pub_budget_limits"
       WHERE "productId" = ${product.id}::text AND "accountId" = ${product.accountId}::text
       FOR SHARE`;
    const limit = await this.budget.limitRow(tx, product.id);
    if (!limit) return { productId: product.id, ok: true, diff: {} };
    const sql = await budgetFn.expected(tx, product.id);
    const heads = await tx.pubExpense.findMany({
      where: { productId: product.id },
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
    const fromEntries = expensesFromEntries(
      heads.map((h) => ({ id: h.id, category: h.category as ExpenseCategory })),
      await this.budget.entriesOf(tx, product.id),
    );
    const ts = expectedCounters([...fromEntries.values()]);
    const diff: Record<string, string> = {};
    const cmp = (name: string, actual: bigint, a: bigint, b: bigint) => {
      if (actual !== a || actual !== b) diff[name] = `${actual}≠${a}/${b}`;
    };
    cmp('netPaid', limit.netPaidMinor, sql.netPaid, ts.netPaid);
    cmp('openCommit', limit.openCommitMinor, sql.openCommit, ts.openCommit);
    cmp(
      'usedPlacements',
      limit.usedPlacementsMinor,
      sql.usedPlacements,
      ts.usedPlacements,
    );
    cmp('usedTools', limit.usedToolsMinor, sql.usedTools, ts.usedTools);
    const headsBad = heads.filter((h) => {
      const x = fromEntries.get(h.id)!;
      return (
        h.amountTotalMinor !== x.amountTotal ||
        h.paidMinor !== x.paid ||
        h.refundedMinor !== x.refunded ||
        h.cancelledMinor !== x.cancelled ||
        h.deliveredMinor !== x.delivered
      );
    }).length;
    if (headsBad || sql.headsBad) diff.heads = `${headsBad}/${sql.headsBad}`;
    const ok = Object.keys(diff).length === 0;
    if (!ok) {
      await this.ports.review().open(
        tx,
        product,
        [
          {
            objectType: 'budget_limit',
            objectId: limit.id,
            reason: 'other',
            triggerRef: `budget-reconcile:${kyivDateOf(now)}`,
            severity: 'critical',
          },
        ],
        { actor: 'system:budget-reconcile' },
      );
      await this.ports.audit().write(tx, {
        accountId: product.accountId,
        productId: product.id,
        actor: 'system:budget-reconcile',
        objectType: 'budget_limit',
        objectId: limit.id,
        action: 'update',
        reason: 'Розбіжність лічильників бюджету — нові зобов’язання зупинено',
        // Только имена расходящихся счётчиков: суммы из 7+ цифр pii-guard
        // принял бы за телефон, а значения видны в самой строке лимита.
        meta: { fields: Object.keys(diff).join(',') },
        occurredAt: now,
      });
    }
    return { productId: product.id, ok, diff };
  }
}
