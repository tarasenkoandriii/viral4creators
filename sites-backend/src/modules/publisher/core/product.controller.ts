/**
 * AI Publisher — маршруты ядра (P-A1, проектный документ §11.3 «P-A1 —
 * продукт, параметры, роли, гейты, аудит, задачи проверки»). Префикс
 * `/publisher`, кабинет — заголовком `X-Site-Account`, роль — матрицей
 * §4.2 (`@PubAllow`). Мутации — через `runOperation` (`opKey` в теле,
 * `expectedRevision` для голов); чтения `opKey` не принимают.
 */
import { Body, Get, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { SitesDb } from '../../../prisma/sites-db.service';
import {
  GATE_NAMES,
  memberActor,
  type GateResult,
  type ParameterView,
  type ProductView,
} from '../contracts/common';
import { isParameterKey } from '../contracts/parameters';
import { PROPOSAL_STATUSES, isOneOf } from '../contracts/states';
import { AuditService } from './audit';
import { PubError, validationError } from './errors';
import { evaluateGate } from './gates';
import { PubOperations } from './operation';
import {
  DECISION_TO_STATUSES,
  ParametersService,
  type DecisionResult,
  type DecisionToStatus,
} from './parameters.service';
import { PubPorts } from './ports';
import { ProductService } from './product.service';
import {
  PubAllow,
  PubCabinetController,
  PubRequest,
  type PubRequestCtx,
} from './pub-role.guard';
import { ReviewTasksService } from './review-tasks.service';
import { parseExpectedRevision } from './revision';
import type { RoleGrantView } from '../contracts/core-api';
import { RoleGrantsService } from './role-grants.service';
import { memberAccessIn } from './product-access.service';
import { can, type PubAccess } from './roles';
import type { Actor } from './state-machines';

type Body = Record<string, unknown>;

function bodyOf(v: unknown): Body {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    throw validationError([{ field: '$', code: 'type' }]);
  }
  return v as Body;
}

function limitOf(v: unknown): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1)
    throw validationError([{ field: 'limit', code: 'range' }]);
  return n;
}

function strOf(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

export function actorsOf(access: PubAccess): Actor[] {
  return [...access.roles, ...(access.admin ? (['admin'] as const) : [])];
}

function product(ctx: PubRequestCtx) {
  if (!ctx.product) throw new PubError('PUB_NOT_FOUND');
  return ctx.product;
}

@PubCabinetController()
export class PublisherCoreController {
  constructor(
    private readonly db: SitesDb,
    private readonly ops: PubOperations,
    private readonly products: ProductService,
    private readonly parameters: ParametersService,
    private readonly grants: RoleGrantsService,
    private readonly review: ReviewTasksService,
    private readonly audit: AuditService,
    private readonly ports: PubPorts,
  ) {}

  private tenant(ctx: PubRequestCtx) {
    return this.db.forAccount(ctx.m.accountId);
  }

  // ── Продукт ─────────────────────────────────────────────────────────────

  @Get('sites/:siteId/product')
  @PubAllow('site.product.read')
  async siteProduct(@PubRequest() ctx: PubRequestCtx) {
    if (!ctx.product) throw new PubError('PUB_PRODUCT_NONE');
    return this.products.view(
      this.tenant(ctx),
      ctx.product.id,
      ctx.access,
      new Date(),
    );
  }

  @Post('sites/:siteId/product')
  @PubAllow('product.create')
  async createProduct(
    @PubRequest() ctx: PubRequestCtx,
    @Param('siteId') siteId: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const body = bodyOf(raw);
    const r = await this.ops.run<ProductView>(
      {
        m: ctx.m,
        access: ctx.access,
        product: null,
        siteId,
        action: 'product.create',
        opKey: body.opKey,
        scope: 'product.create',
        pathParams: { siteId },
        body,
        // Профиль несёт `name` (ключ из списка ПД триггера ключа): в ключе —
        // только hash и id, повтор пересобирает профиль (Р-PUB-A1-13).
        storeResponse: false,
        refOf: (v) => ({ productId: v.id }),
        rebuild: (tx, ref) =>
          this.products.view(
            tx,
            String(ref?.productId),
            ctx.access,
            new Date(),
          ),
      },
      async (tx, step) => {
        const p = await this.products.create(
          tx,
          ctx.m.accountId,
          siteId,
          { name: body.name, kind: body.kind },
          step.actor,
          step.now,
        );
        return {
          status: 201,
          body: await this.products.view(tx, p.id, ctx.access, step.now),
          audit: [],
        };
      },
    );
    res.status(r.status);
    return r.body;
  }

  @Get('products/:pid')
  @PubAllow('product.read')
  async getProduct(@PubRequest() ctx: PubRequestCtx) {
    return this.products.view(
      this.tenant(ctx),
      product(ctx).id,
      ctx.access,
      new Date(),
    );
  }

  @Patch('products/:pid')
  @PubAllow('product.update')
  async patchProduct(
    @PubRequest() ctx: PubRequestCtx,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const body = bodyOf(raw);
    const p = product(ctx);
    const expectedRevision = parseExpectedRevision(body.expectedRevision);
    const r = await this.ops.run<ProductView>(
      {
        m: ctx.m,
        access: ctx.access,
        product: p,
        action: 'product.update',
        opKey: body.opKey,
        scope: 'product.update',
        pathParams: { pid: p.id },
        body,
        storeResponse: false,
        rebuild: (tx) => this.products.view(tx, p.id, ctx.access, new Date()),
      },
      async (tx, step) => {
        await this.products.rename(
          tx,
          p,
          { name: body.name, expectedRevision },
          step.actor,
        );
        return {
          status: 200,
          body: await this.products.view(tx, p.id, ctx.access, step.now),
          audit: [],
        };
      },
    );
    res.status(r.status);
    return r.body;
  }

  @Post('products/:pid/mode')
  @PubAllow('product.mode')
  async changeMode(
    @PubRequest() ctx: PubRequestCtx,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const body = bodyOf(raw);
    const p = product(ctx);
    const expectedRevision = parseExpectedRevision(body.expectedRevision);
    const r = await this.ops.run<ProductView>(
      {
        m: ctx.m,
        access: ctx.access,
        product: p,
        action: 'product.mode',
        opKey: body.opKey,
        scope: 'product.mode',
        pathParams: { pid: p.id },
        body,
        storeResponse: false,
        rebuild: (tx) => this.products.view(tx, p.id, ctx.access, new Date()),
      },
      async (tx, step) => {
        await this.products.changeMode(
          tx,
          p,
          { mode: body.mode, expectedRevision, reason: body.reason },
          step.actor,
          step.now,
        );
        return {
          status: 200,
          body: await this.products.view(tx, p.id, ctx.access, step.now),
          audit: [],
        };
      },
    );
    res.status(r.status);
    return r.body;
  }

  // ── Параметры ───────────────────────────────────────────────────────────

  @Get('products/:pid/parameters')
  @PubAllow('product.read')
  async listParameters(@PubRequest() ctx: PubRequestCtx) {
    return {
      items: await this.parameters.list(this.tenant(ctx), product(ctx).id),
    };
  }

  @Get('products/:pid/parameters/decisions')
  @PubAllow('product.read')
  async listDecisions(
    @PubRequest() ctx: PubRequestCtx,
    @Query('key') key?: string,
    @Query('before') before?: string,
    @Query('limit') limit?: string,
  ) {
    if (key !== undefined && !isParameterKey(key)) {
      throw validationError([{ field: 'key', code: 'enum' }]);
    }
    return this.parameters.decisions(this.tenant(ctx), product(ctx).id, {
      key,
      before: strOf(before),
      limit: limitOf(limit),
    });
  }

  @Get('products/:pid/parameters/:key/proposals')
  @PubAllow('product.read')
  async listProposals(
    @PubRequest() ctx: PubRequestCtx,
    @Param('key') key: string,
    @Query('status') status?: string,
    @Query('before') before?: string,
    @Query('limit') limit?: string,
  ) {
    if (!isParameterKey(key)) throw new PubError('PUB_NOT_FOUND');
    if (status !== undefined && !isOneOf(PROPOSAL_STATUSES, status)) {
      throw validationError([{ field: 'status', code: 'enum' }]);
    }
    return this.parameters.proposals(this.tenant(ctx), product(ctx).id, key, {
      status,
      before: strOf(before),
      limit: limitOf(limit),
      actor: memberActor(ctx.m.memberId),
      mayPropose: can(ctx.access, 'parameter.propose'),
      // То же правило, что у маршрута withdraw.
      mayWithdrawOthers:
        can(ctx.access, 'parameter.decide') || ctx.access.admin,
    });
  }

  @Post('products/:pid/parameters/:key/proposals')
  @PubAllow('parameter.propose')
  async propose(
    @PubRequest() ctx: PubRequestCtx,
    @Param('key') key: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const body = bodyOf(raw);
    const p = product(ctx);
    if (!isParameterKey(key)) throw new PubError('PUB_NOT_FOUND');
    if (!('value' in body))
      throw validationError([{ field: 'value', code: 'required' }]);
    const r = await this.ops.run<{
      proposalId: string;
      parameter: ParameterView;
    }>(
      {
        m: ctx.m,
        access: ctx.access,
        product: p,
        action: 'parameter.propose',
        opKey: body.opKey,
        scope: 'parameter.propose',
        pathParams: { pid: p.id, key },
        body,
        // Значение параметра может нести `name` (event_map, own_channels).
        storeResponse: false,
        refOf: (v) => ({ proposalId: v.proposalId }),
        rebuild: async (tx, ref) => ({
          proposalId: String(ref?.proposalId),
          parameter: await this.parameters.viewOf(tx, p.id, key),
        }),
      },
      async (tx, step) => ({
        status: 201,
        body: await this.parameters.propose(tx, p, key, body.value, step.actor),
        audit: [],
      }),
    );
    res.status(r.status);
    return r.body;
  }

  @Post('products/:pid/parameters/:key/proposals/:id/withdraw')
  @PubAllow('parameter.propose')
  async withdraw(
    @PubRequest() ctx: PubRequestCtx,
    @Param('key') key: string,
    @Param('id') id: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const body = bodyOf(raw);
    const p = product(ctx);
    const r = await this.ops.run(
      {
        m: ctx.m,
        access: ctx.access,
        product: p,
        action: 'parameter.propose',
        opKey: body.opKey,
        scope: 'parameter.withdraw',
        pathParams: { pid: p.id, key, id },
        body,
      },
      async (tx, step) => ({
        status: 200,
        body: await this.parameters.withdraw(
          tx,
          p,
          key,
          id,
          step.actor,
          can(ctx.access, 'parameter.decide') || ctx.access.admin,
        ),
        audit: [],
      }),
    );
    res.status(r.status);
    return r.body;
  }

  @Post('products/:pid/parameters/:key/decision')
  @PubAllow('parameter.decide')
  async decide(
    @PubRequest() ctx: PubRequestCtx,
    @Param('key') key: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const body = bodyOf(raw);
    const p = product(ctx);
    if (!isParameterKey(key)) throw new PubError('PUB_NOT_FOUND');
    const toStatus = body.toStatus as DecisionToStatus;
    if (!DECISION_TO_STATUSES.includes(toStatus)) {
      throw validationError([{ field: 'toStatus', code: 'enum' }]);
    }
    if (
      body.proposalId !== undefined &&
      body.proposalId !== null &&
      typeof body.proposalId !== 'string'
    ) {
      throw validationError([{ field: 'proposalId', code: 'type' }]);
    }
    if (
      body.dependentStages !== undefined &&
      !Array.isArray(body.dependentStages)
    ) {
      throw validationError([{ field: 'dependentStages', code: 'type' }]);
    }
    const expectedRevision = parseExpectedRevision(body.expectedRevision);
    const r = await this.ops.run<DecisionResult>(
      {
        m: ctx.m,
        access: ctx.access,
        product: p,
        action: 'parameter.decide',
        opKey: body.opKey,
        scope: 'parameter.decide',
        pathParams: { pid: p.id, key },
        body,
        storeResponse: false,
        refOf: (v) => ({
          decisionId: v.decisionId,
          version: v.version,
          proposalStatus: v.proposalStatus,
        }),
        rebuild: async (tx, ref) => ({
          decisionId: (ref?.decisionId as string | null) ?? null,
          version: Number(ref?.version),
          proposalStatus: (ref?.proposalStatus as string | null) ?? null,
          parameter: await this.parameters.viewOf(tx, p.id, key),
        }),
      },
      async (tx, step) => ({
        status: 200,
        body: await this.parameters.decide(tx, p, {
          key,
          toStatus,
          proposalId: (body.proposalId as string | null | undefined) ?? null,
          basis: body.basis as string,
          decidedBy: step.actor,
          dependentStages: body.dependentStages as never,
          expectedRevision,
          actors: actorsOf(ctx.access),
          now: step.now,
        }),
        audit: [],
      }),
    );
    res.status(r.status);
    return r.body;
  }

  // ── Гейты ───────────────────────────────────────────────────────────────

  @Get('products/:pid/gates')
  @PubAllow('product.read')
  async gates(@PubRequest() ctx: PubRequestCtx) {
    const now = new Date();
    const out: Record<string, GateResult> = {};
    const db = this.tenant(ctx);
    for (const g of GATE_NAMES)
      out[g] = await evaluateGate(db, product(ctx).id, g, now);
    return out;
  }

  // ── Роли ────────────────────────────────────────────────────────────────

  @Get('products/:pid/roles')
  @PubAllow('role.manage')
  async roles(@PubRequest() ctx: PubRequestCtx) {
    return { items: await this.grants.list(this.tenant(ctx), product(ctx).id) };
  }

  @Post('products/:pid/roles')
  @PubAllow('role.manage')
  async grant(
    @PubRequest() ctx: PubRequestCtx,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const body = bodyOf(raw);
    const p = product(ctx);
    const r = await this.ops.run<RoleGrantView>(
      {
        m: ctx.m,
        access: ctx.access,
        product: p,
        action: 'role.manage',
        opKey: body.opKey,
        scope: 'role.grant',
        pathParams: { pid: p.id },
        body,
        // Аудит P3-14в: в ответе снимок имени участника — в ключе
        // идемпотентности его 30 дней не держим; повтор пересобирает.
        storeResponse: false,
        refOf: (v) => ({ grantId: v.id }),
        rebuild: async (tx, ref) =>
          this.grants.view(tx, p.id, String(ref?.grantId)),
      },
      async (tx, step) => ({
        status: 201,
        body: await this.grants.grant(
          tx,
          p,
          {
            memberId: body.memberId,
            role: body.role,
            displayName: body.displayName,
          },
          { id: step.actor, memberId: ctx.m.memberId },
        ),
        audit: [],
      }),
    );
    res.status(r.status);
    return r.body;
  }

  @Post('products/:pid/roles/:grantId/revoke')
  @PubAllow('role.manage')
  async revoke(
    @PubRequest() ctx: PubRequestCtx,
    @Param('grantId') grantId: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const body = bodyOf(raw);
    const p = product(ctx);
    const r = await this.ops.run(
      {
        m: ctx.m,
        access: ctx.access,
        product: p,
        action: 'role.manage',
        opKey: body.opKey,
        scope: 'role.revoke',
        pathParams: { pid: p.id, grantId },
        body,
      },
      async (tx, step) => ({
        status: 200,
        body: await this.grants.revoke(
          tx,
          p,
          grantId,
          body.reason,
          step.actor,
          step.now,
        ),
        audit: [],
      }),
    );
    res.status(r.status);
    return r.body;
  }

  // ── Журнал аудита ───────────────────────────────────────────────────────

  @Get('products/:pid/audit')
  @PubAllow('audit.read')
  async auditLog(
    @PubRequest() ctx: PubRequestCtx,
    @Query('objectType') objectType?: string,
    @Query('objectId') objectId?: string,
    @Query('before') before?: string,
    @Query('limit') limit?: string,
  ) {
    return this.audit.list(this.tenant(ctx), product(ctx).id, {
      objectType: strOf(objectType),
      objectId: strOf(objectId),
      before: strOf(before),
      limit: limitOf(limit),
    });
  }

  // ── Задачи проверки ─────────────────────────────────────────────────────

  /** Продажам (без ED/PO) — только задачи ретенции (§11.3). */
  private retentionOnly(access: PubAccess): boolean {
    return !can(access, 'review.manage');
  }

  @Get('products/:pid/review-tasks')
  @PubAllow('review.manage', 'review.retention')
  async reviewTasks(
    @PubRequest() ctx: PubRequestCtx,
    @Query('status') status?: string,
    @Query('assignee') assignee?: string,
    @Query('reason') reason?: string,
    @Query('before') before?: string,
    @Query('limit') limit?: string,
  ) {
    const only = this.retentionOnly(ctx.access);
    if (only && reason !== undefined && reason !== 'retention_review') {
      throw new PubError('PUB_ROLE_REQUIRED', { action: 'review.manage' });
    }
    return this.review.list(this.tenant(ctx), product(ctx).id, {
      status: strOf(status),
      assignee: strOf(assignee),
      reason: strOf(reason),
      reasons: only ? ['retention_review'] : undefined,
      before: strOf(before),
      limit: limitOf(limit),
    });
  }

  @Post('products/:pid/review-tasks/:id/resolve')
  @PubAllow('review.manage', 'review.retention')
  async resolveTask(
    @PubRequest() ctx: PubRequestCtx,
    @Param('id') id: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const body = bodyOf(raw);
    const p = product(ctx);
    const expectedRevision = parseExpectedRevision(body.expectedRevision);
    if (body.status !== 'resolved' && body.status !== 'dismissed') {
      throw validationError([{ field: 'status', code: 'enum' }]);
    }
    if (
      typeof body.resolution !== 'string' ||
      !body.resolution.trim() ||
      [...body.resolution].length > 2000
    ) {
      throw validationError([{ field: 'resolution', code: 'length' }]);
    }
    const status = body.status;
    const resolution = body.resolution;
    const r = await this.ops.run(
      {
        m: ctx.m,
        access: ctx.access,
        product: p,
        action: this.retentionOnly(ctx.access)
          ? 'review.retention'
          : 'review.manage',
        opKey: body.opKey,
        scope: 'review.resolve',
        pathParams: { pid: p.id, id },
        body,
      },
      async (tx, step) => {
        await this.assertTaskVisible(tx, p.id, id, ctx.access);
        const view = await this.review.resolve(tx, p, id, {
          status,
          resolution,
          expectedRevision,
          actor: step.actor,
          actors: actorsOf(ctx.access),
          now: step.now,
        });
        return {
          status: 200,
          body: view,
          audit: [
            {
              objectType: 'review_task',
              objectId: id,
              action: status === 'resolved' ? 'resolve' : 'dismiss',
              fromStatus: 'open',
              toStatus: status,
              reason: resolution,
            },
          ],
        };
      },
    );
    res.status(r.status);
    return r.body;
  }

  @Post('products/:pid/review-tasks/:id/assign')
  @PubAllow('review.manage', 'review.retention')
  async assignTask(
    @PubRequest() ctx: PubRequestCtx,
    @Param('id') id: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const body = bodyOf(raw);
    const p = product(ctx);
    const expectedRevision = parseExpectedRevision(body.expectedRevision);
    const assignee = body.assigneeMemberId ?? null;
    if (
      assignee !== null &&
      (typeof assignee !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(assignee))
    ) {
      throw validationError([{ field: 'assigneeMemberId', code: 'format' }]);
    }
    const r = await this.ops.run(
      {
        m: ctx.m,
        access: ctx.access,
        product: p,
        action: this.retentionOnly(ctx.access)
          ? 'review.retention'
          : 'review.manage',
        opKey: body.opKey,
        scope: 'review.assign',
        pathParams: { pid: p.id, id },
        body,
      },
      async (tx) => {
        const task = await this.assertTaskVisible(tx, p.id, id, ctx.access);
        if (assignee !== null) {
          // Аудит P3-14а: исполнитель — участник с допуском к Publisher и
          // правом решать задачу (ретенция — review.retention или manage).
          const access = await memberAccessIn(tx, p.id, assignee);
          if (!access)
            throw validationError([
              { field: 'assigneeMemberId', code: 'not_member' },
            ]);
          const may =
            can(access, 'review.manage') ||
            (task.reason === 'retention_review' &&
              can(access, 'review.retention'));
          if (!may)
            throw validationError([
              { field: 'assigneeMemberId', code: 'no_review_access' },
            ]);
        }
        const view = await this.review.assign(tx, p, id, {
          assigneeMemberId: assignee,
          expectedRevision,
        });
        return {
          status: 200,
          body: view,
          audit: [
            {
              objectType: 'review_task',
              objectId: id,
              action: 'assign',
              meta: { assigneeMemberId: assignee },
            },
          ],
        };
      },
    );
    res.status(r.status);
    return r.body;
  }

  private async assertTaskVisible(
    tx: Parameters<ReviewTasksService['get']>[0],
    productId: string,
    id: string,
    access: PubAccess,
  ): Promise<{ reason: string }> {
    const task = await this.review.get(tx, productId, id);
    if (this.retentionOnly(access) && task.reason !== 'retention_review') {
      throw new PubError('PUB_ROLE_REQUIRED', { action: 'review.manage' });
    }
    return task;
  }

  // ── Тестовый стенд ──────────────────────────────────────────────────────

  @Post('products/:pid/test/rate-limit/reset')
  @PubAllow('test.rate_limit.reset')
  async resetRateLimit(
    @PubRequest() ctx: PubRequestCtx,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const body = bodyOf(raw);
    const p = product(ctx);
    const r = await this.ops.run(
      {
        m: ctx.m,
        access: ctx.access,
        product: p,
        action: 'test.rate_limit.reset',
        opKey: body.opKey,
        scope: 'test.rate_limit.reset',
        pathParams: { pid: p.id },
        body,
      },
      async (tx) => {
        const cur = await tx.pubProduct.findFirst({
          where: { id: p.id },
          select: { mode: true, kind: true },
        });
        if (!cur || (cur.mode !== 'test' && cur.kind !== 'test')) {
          throw validationError([{ field: 'mode', code: 'not_test' }]);
        }
        const removed = await this.ports.rateLimitReset().reset(tx, p);
        return {
          status: 200,
          body: { removed },
          audit: [
            {
              objectType: 'product',
              objectId: p.id,
              action: 'reset',
              meta: { what: 'form_rate_limit', removed },
            },
          ],
        };
      },
    );
    res.status(r.status);
    return r.body;
  }
}
