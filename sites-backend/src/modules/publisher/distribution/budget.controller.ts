/**
 * AI Publisher, P-C — маршруты закупок, расходов и бюджета F12 (проектный
 * документ §11.3; контракт `contracts/distribution-api.ts`). Движение денег
 * — только функциями `sites.pub_budget_*` (§8.2) внутри `runOperation`.
 */
import { Body, Get, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { SitesDb } from '../../../prisma/sites-db.service';
import type { BudgetView } from '../contracts/distribution-api';
import { PubError, validationError } from '../core/errors';
import { PubOperations } from '../core/operation';
import {
  PubAllow,
  PubCabinetController,
  PubRequest,
  type PubRequestCtx,
} from '../core/pub-role.guard';
import { budgetFn } from './budget-fn';
import { BudgetService } from './budget.service';
import { PurchaseApprovalsService } from './approvals-purchase.service';
import { ExpensesService } from './expenses.service';
import {
  formatOf,
  limitOf,
  mutate,
  productOf,
  respondList,
  strQ,
} from './http';
import { Fields } from './input';
import { PlacementsService, placementView } from './placements.service';

@PubCabinetController()
export class PublisherBudgetController {
  constructor(
    private readonly db: SitesDb,
    private readonly ops: PubOperations,
    private readonly placements: PlacementsService,
    private readonly expenses: ExpensesService,
    private readonly budget: BudgetService,
    private readonly approvals: PurchaseApprovalsService,
  ) {}

  private tenant(ctx: PubRequestCtx) {
    return this.db.forAccount(ctx.m.accountId);
  }

  // ── Закупки ────────────────────────────────────────────────────────────

  @Get('products/:pid/placements')
  @PubAllow('product.read')
  async listPlacements(
    @PubRequest() ctx: PubRequestCtx,
    @Query() q: Record<string, unknown>,
    @Res() res: Response,
  ) {
    const format = formatOf(q.format);
    const limit = limitOf(q.limit, format === 'csv');
    const rows = await this.placements.list(
      this.tenant(ctx),
      productOf(ctx).id,
      {
        status: strQ(q.status),
        before: strQ(q.before),
        limit: limit + 1,
      },
    );
    await respondList(
      res,
      this.ops,
      ctx,
      'placements',
      format,
      rows.map((r) => placementView(r)),
      limit,
      [
        'id',
        'purchaseSeq',
        'placementCode',
        'venueId',
        'versionId',
        'status',
        'paymentStatus',
        'totalPriceMinor',
        'currency',
        'externalOrderId',
        'publishDueAt',
        'publishedAt',
        'verifiedAt',
        'claimStatus',
        'nextActionAt',
        'issuedUrl',
      ],
    );
  }

  @Get('products/:pid/placements/:id')
  @PubAllow('product.read')
  async getPlacement(
    @PubRequest() ctx: PubRequestCtx,
    @Param('id') id: string,
  ) {
    return this.placements.view(this.tenant(ctx), productOf(ctx).id, id);
  }

  @Post('products/:pid/placements')
  @PubAllow('placement.propose')
  createPlacement(
    @PubRequest() ctx: PubRequestCtx,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return mutate(res, {
      ops: this.ops,
      ctx,
      action: 'placement.propose',
      scope: 'placement.create',
      pathParams: { pid: productOf(ctx).id },
      raw,
      status: 201,
      fn: (tx, step, b) =>
        this.placements.propose(tx, productOf(ctx), ctx.access, step, b),
    });
  }

  @Patch('products/:pid/placements/:id')
  @PubAllow('placement.propose')
  patchPlacement(
    @PubRequest() ctx: PubRequestCtx,
    @Param('id') id: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return mutate(res, {
      ops: this.ops,
      ctx,
      action: 'placement.propose',
      scope: 'placement.update',
      pathParams: { pid: productOf(ctx).id, id },
      raw,
      status: 200,
      fn: (tx, step, b) =>
        this.placements.patch(tx, productOf(ctx), step, id, b),
    });
  }

  @Post('products/:pid/placements/:id/approve')
  @PubAllow('placement.approve')
  approve(
    @PubRequest() ctx: PubRequestCtx,
    @Param('id') id: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return mutate(res, {
      ops: this.ops,
      ctx,
      action: 'placement.approve',
      scope: 'placement.approve',
      pathParams: { pid: productOf(ctx).id, id },
      raw,
      status: 200,
      fn: (tx, step, b, opKey) =>
        this.placements.approve(
          tx,
          productOf(ctx),
          ctx.access,
          step,
          id,
          b,
          opKey,
        ),
    });
  }

  @Post('products/:pid/placements/:id/reserve')
  @PubAllow('budget.operate')
  reserve(
    @PubRequest() ctx: PubRequestCtx,
    @Param('id') id: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return mutate(res, {
      ops: this.ops,
      ctx,
      action: 'budget.operate',
      scope: 'placement.reserve',
      pathParams: { pid: productOf(ctx).id, id },
      raw,
      status: 200,
      fn: (tx, step, b, opKey) =>
        this.placements.reserve(
          tx,
          productOf(ctx),
          ctx.access,
          step,
          id,
          b,
          opKey,
        ),
    });
  }

  @Post('products/:pid/placements/:id/order')
  @PubAllow('budget.operate')
  order(
    @PubRequest() ctx: PubRequestCtx,
    @Param('id') id: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return mutate(res, {
      ops: this.ops,
      ctx,
      action: 'budget.operate',
      scope: 'placement.order',
      pathParams: { pid: productOf(ctx).id, id },
      raw,
      status: 200,
      fn: (tx, step, b) =>
        this.placements.order(tx, productOf(ctx), ctx.access, step, id, b),
    });
  }

  @Post('products/:pid/placements/:id/publication')
  @PubAllow('budget.operate')
  awaitPublication(
    @PubRequest() ctx: PubRequestCtx,
    @Param('id') id: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return mutate(res, {
      ops: this.ops,
      ctx,
      action: 'budget.operate',
      scope: 'placement.await_publication',
      pathParams: { pid: productOf(ctx).id, id },
      raw,
      status: 200,
      fn: (tx, _step, b) =>
        this.placements.awaitPublication(tx, productOf(ctx), ctx.access, id, b),
    });
  }

  @Post('products/:pid/placements/:id/published')
  @PubAllow('budget.operate')
  published(
    @PubRequest() ctx: PubRequestCtx,
    @Param('id') id: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return mutate(res, {
      ops: this.ops,
      ctx,
      action: 'budget.operate',
      scope: 'placement.published',
      pathParams: { pid: productOf(ctx).id, id },
      raw,
      status: 200,
      fn: (tx, step, b) =>
        this.placements.published(tx, productOf(ctx), ctx.access, step, id, b),
    });
  }

  @Post('products/:pid/placements/:id/verify')
  @PubAllow('budget.operate')
  verify(
    @PubRequest() ctx: PubRequestCtx,
    @Param('id') id: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return mutate(res, {
      ops: this.ops,
      ctx,
      action: 'budget.operate',
      scope: 'placement.verify',
      pathParams: { pid: productOf(ctx).id, id },
      raw,
      status: 200,
      fn: (tx, step, b) =>
        this.placements.verify(tx, productOf(ctx), ctx.access, step, id, b),
    });
  }

  @Post('products/:pid/placements/:id/dispute')
  @PubAllow('placement.claim')
  dispute(
    @PubRequest() ctx: PubRequestCtx,
    @Param('id') id: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return mutate(res, {
      ops: this.ops,
      ctx,
      action: 'placement.claim',
      scope: 'placement.dispute',
      pathParams: { pid: productOf(ctx).id, id },
      raw,
      status: 200,
      fn: (tx, _step, b) =>
        this.placements.dispute(tx, productOf(ctx), ctx.access, id, b),
    });
  }

  @Post('products/:pid/placements/:id/dispute/resolve')
  @PubAllow('placement.claim')
  resolveDispute(
    @PubRequest() ctx: PubRequestCtx,
    @Param('id') id: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return mutate(res, {
      ops: this.ops,
      ctx,
      action: 'placement.claim',
      scope: 'placement.dispute.resolve',
      pathParams: { pid: productOf(ctx).id, id },
      raw,
      status: 200,
      fn: (tx, step, b, opKey) =>
        this.placements.resolveDispute(
          tx,
          productOf(ctx),
          ctx.access,
          step,
          id,
          b,
          opKey,
        ),
    });
  }

  @Post('products/:pid/placements/:id/cancel')
  @PubAllow('budget.operate')
  cancel(
    @PubRequest() ctx: PubRequestCtx,
    @Param('id') id: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return mutate(res, {
      ops: this.ops,
      ctx,
      action: 'budget.operate',
      scope: 'placement.cancel',
      pathParams: { pid: productOf(ctx).id, id },
      raw,
      status: 200,
      fn: (tx, step, b, opKey) =>
        this.placements.cancel(
          tx,
          productOf(ctx),
          ctx.access,
          step,
          id,
          b,
          opKey,
        ),
    });
  }

  @Post('products/:pid/placements/:id/reject')
  @PubAllow('placement.propose')
  reject(
    @PubRequest() ctx: PubRequestCtx,
    @Param('id') id: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return mutate(res, {
      ops: this.ops,
      ctx,
      action: 'placement.propose',
      scope: 'placement.reject',
      pathParams: { pid: productOf(ctx).id, id },
      raw,
      status: 200,
      fn: (tx, _step, b) =>
        this.placements.reject(tx, productOf(ctx), ctx.access, id, b),
    });
  }

  // ── Расходы ────────────────────────────────────────────────────────────

  @Get('products/:pid/expenses')
  @PubAllow('product.read')
  async listExpenses(
    @PubRequest() ctx: PubRequestCtx,
    @Query() q: Record<string, unknown>,
    @Res() res: Response,
  ) {
    const format = formatOf(q.format);
    const limit = limitOf(q.limit, format === 'csv');
    const rows = await this.expenses.list(this.tenant(ctx), productOf(ctx).id, {
      category: strQ(q.category),
      status: strQ(q.status),
      before: strQ(q.before),
      limit: limit + 1,
    });
    await respondList(res, this.ops, ctx, 'expenses', format, rows, limit, [
      'id',
      'category',
      'description',
      'placementId',
      'currency',
      'amountTotalMinor',
      'paidMinor',
      'refundedMinor',
      'cancelledMinor',
      'deliveredMinor',
      'openCommitmentMinor',
      'deliveredUnpaidMinor',
      'paymentStatus',
      'reconcileRequired',
      'status',
    ]);
  }

  @Get('products/:pid/expenses/:id')
  @PubAllow('product.read')
  async getExpense(@PubRequest() ctx: PubRequestCtx, @Param('id') id: string) {
    return this.expenses.view(this.tenant(ctx), productOf(ctx).id, id);
  }

  @Post('products/:pid/expenses')
  @PubAllow('budget.operate')
  createExpense(
    @PubRequest() ctx: PubRequestCtx,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return mutate(res, {
      ops: this.ops,
      ctx,
      action: 'budget.operate',
      scope: 'expense.create',
      pathParams: { pid: productOf(ctx).id },
      raw,
      status: 201,
      fn: (tx, step, b, opKey) =>
        this.expenses.create(tx, productOf(ctx), step, b, opKey),
    });
  }

  @Post('products/:pid/expenses/:id/entries')
  @PubAllow('budget.operate')
  createEntry(
    @PubRequest() ctx: PubRequestCtx,
    @Param('id') id: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return mutate(res, {
      ops: this.ops,
      ctx,
      action: 'budget.operate',
      scope: 'expense.entry',
      pathParams: { pid: productOf(ctx).id, id },
      raw,
      status: 201,
      fn: (tx, step, b, opKey) =>
        this.expenses.entry(tx, productOf(ctx), step, id, b, opKey),
    });
  }

  @Post('products/:pid/expenses/:id/entries/:eid/reconcile')
  @PubAllow('budget.operate')
  reconcileEntry(
    @PubRequest() ctx: PubRequestCtx,
    @Param('id') id: string,
    @Param('eid') eid: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return mutate(res, {
      ops: this.ops,
      ctx,
      action: 'budget.operate',
      scope: 'expense.entry.reconcile',
      pathParams: { pid: productOf(ctx).id, id, eid },
      raw,
      status: 200,
      fn: (tx, step, b) =>
        this.expenses.reconcile(tx, productOf(ctx), step, id, eid, b),
    });
  }

  // ── Бюджет ─────────────────────────────────────────────────────────────

  @Get('products/:pid/budget')
  @PubAllow('product.read')
  async budgetView(@PubRequest() ctx: PubRequestCtx): Promise<BudgetView> {
    return this.budget.view(this.tenant(ctx), productOf(ctx).id);
  }

  /**
   * Пересборка счётчиков бюджета из записей (Р-PUB-C-4, S2-4) — решение
   * владельца продукта с основанием: после расхождения (запись мимо
   * функций) головы обязательств и счётчики строки лимита пересчитываются
   * функцией `pub_budget_rebuild_counters` (строгая сверка в конце), записи
   * движения денег не меняются. Аудит — поправки по счётчикам. Остановку
   * ежедневной сверкой снимает владелец, закрыв её задачу.
   */
  @Post('products/:pid/budget/rebuild-counters')
  @PubAllow('budget.reserve_release')
  rebuildCounters(
    @PubRequest() ctx: PubRequestCtx,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return mutate(res, {
      ops: this.ops,
      ctx,
      action: 'budget.reserve_release',
      scope: 'budget.rebuild_counters',
      pathParams: { pid: productOf(ctx).id },
      raw,
      status: 200,
      fn: async (tx, _step, b) => {
        const f = new Fields();
        const basis = f.str(b, 'basis', 2000);
        f.done();
        if (!basis || basis.length < 10) {
          throw validationError([{ field: 'basis', code: 'length' }]);
        }
        const p = productOf(ctx);
        const limit = await this.budget.limitRow(tx, p.id);
        if (!limit) {
          throw new PubError('PUB_GATE_CLOSED', {
            gate: 'spend',
            missing: [
              { kind: 'budget', key: 'pub_budget_limits', detail: 'not_built' },
            ],
          });
        }
        const fix = await budgetFn.rebuildCounters(tx, p);
        return {
          body: await this.budget.view(tx, p.id),
          audit: [
            {
              objectType: 'budget_limit',
              objectId: limit.id,
              action: 'update',
              reason: basis,
              meta: {
                rebuild: true,
                heads: fix.heads,
                netPaidDelta: fix.netPaid,
                openCommitDelta: fix.openCommit,
                usedPlacementsDelta: fix.usedPlacements,
                usedToolsDelta: fix.usedTools,
              },
            },
          ],
        };
      },
    });
  }

  /**
   * Перевод защищённого резерва в категорию — решение владельца продукта
   * (согласование `reserve_release` + перевод одной операцией); общий
   * лимит не меняется (ТЗ §17, AT-F12-01).
   */
  @Post('products/:pid/budget/reserve-release')
  @PubAllow('budget.reserve_release')
  reserveRelease(
    @PubRequest() ctx: PubRequestCtx,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return mutate(res, {
      ops: this.ops,
      ctx,
      action: 'budget.reserve_release',
      scope: 'budget.reserve_release',
      pathParams: { pid: productOf(ctx).id },
      raw,
      status: 200,
      fn: async (tx, step, b) => {
        const f = new Fields();
        const toCategory = f.oneOf(b, 'toCategory', [
          'placements',
          'tools',
        ] as const);
        const amount = f.minor(b, 'amountMinor', { positive: true });
        const basis = f.str(b, 'basis', 2000);
        f.done();
        if (!toCategory || amount === null || !basis) {
          throw validationError([{ field: '$', code: 'required' }]);
        }
        if (basis.length < 10) {
          throw validationError([{ field: 'basis', code: 'length' }]);
        }
        const p = productOf(ctx);
        const limit = await this.budget.limitRow(tx, p.id);
        if (!limit) {
          throw new PubError('PUB_GATE_CLOSED', {
            gate: 'spend',
            missing: [
              { kind: 'budget', key: 'pub_budget_limits', detail: 'not_built' },
            ],
          });
        }
        if (limit.protectedReserveMinor < amount) {
          throw new PubError('PUB_BUDGET_INSUFFICIENT', {
            available: limit.protectedReserveMinor.toString(),
            requested: amount.toString(),
            reason: 'protected_reserve',
          });
        }
        const approvalId = await this.approvals.createReserveRelease(tx, p, {
          limitId: limit.id,
          amountMinor: amount,
          currency: limit.currency,
          approverMemberId: ctx.access.memberId,
          reason: basis,
          actor: step.actor,
          now: step.now,
        });
        const moveId = await budgetFn.release(tx, p, {
          toCategory,
          amount,
          approvalId,
          actor: step.actor,
        });
        return {
          body: await this.budget.view(tx, p.id),
          audit: [
            {
              objectType: 'approval',
              objectId: approvalId,
              action: 'approve',
              toStatus: 'active',
              reason: basis,
              meta: { type: 'reserve_release', amountMinor: Number(amount) },
            },
            {
              objectType: 'reserve_move',
              objectId: moveId ?? approvalId,
              action: 'create',
              meta: { toCategory, amountMinor: Number(amount), approvalId },
            },
          ],
        };
      },
    });
  }
}
