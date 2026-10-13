/**
 * AI Publisher — маршруты кабинета P-D (проектный документ §11.3 «P-D —
 * заявки, продажи, паспорт трафика»; контракт `contracts/leads-api.ts`).
 * Префикс `/publisher/products/:pid`, роль — матрица §4.2 (`@PubAllow`),
 * мутации — `runOperation` (`opKey` в теле, `expectedRevision` для голов),
 * чтения `opKey` не принимают. Ответы не несут контактов, имени, текста
 * задачи и заметок (раскрытие — `contacts.controller.ts`). Выгрузка CSV
 * (`?format=csv`) — без контактов и заметок, с экранированием формул и
 * записью аудита `export`.
 */
import { Body, Get, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { randomUUID } from 'crypto';
import { SitesDb } from '../../../prisma/sites-db.service';
import type { LeadCardView } from '../contracts/leads-api';
import { PUB_NO_STORE, PubError, validationError } from '../core/errors';
import { PubOperations, type OperationOutput } from '../core/operation';
import type { PubTx } from '../core/ports';
import { actorsOf } from '../core/product.controller';
import {
  PubAllow,
  PubCabinetController,
  PubRequest,
  type PubRequestCtx,
} from '../core/pub-role.guard';
import type { PubAction } from '../core/roles';
import { LeadEnrichService } from './lead-enrich.job';
import { LEAD_CSV_COLUMNS, toCsv } from './lead-views';
import { LeadsService, basisOf, type OpStep } from './leads.service';
import { NotificationsService } from './notifications.service';
import { PaymentsService } from './payments.service';
import { ProspectsService, noteOf } from './prospects.service';
import { QueueChecksService } from './queue-checks.service';
import { TrafficPassportService } from './traffic-passport.service';

type Body = Record<string, unknown>;

export function bodyOf(v: unknown): Body {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    throw validationError([{ field: '$', code: 'type' }]);
  }
  return v as Body;
}

function productOf(ctx: PubRequestCtx) {
  if (!ctx.product) throw new PubError('PUB_NOT_FOUND');
  return ctx.product;
}

/** Строк в одной CSV-выгрузке очереди. */
export const CSV_MAX_ROWS = 5000;

@PubCabinetController('products/:pid')
export class PublisherLeadsController {
  constructor(
    private readonly db: SitesDb,
    private readonly ops: PubOperations,
    private readonly leads: LeadsService,
    private readonly prospects: ProspectsService,
    private readonly payments: PaymentsService,
    private readonly notifications: NotificationsService,
    private readonly queueChecks: QueueChecksService,
    private readonly traffic: TrafficPassportService,
    private readonly enrich: LeadEnrichService,
  ) {}

  private tenant(ctx: PubRequestCtx) {
    return this.db.forAccount(ctx.m.accountId);
  }

  /** Мутация через `runOperation` (ответ хранится в ключе — без ПД). */
  private async mutate<T>(
    ctx: PubRequestCtx,
    action: PubAction,
    scope: string,
    pathParams: Record<string, string>,
    raw: unknown,
    res: Response,
    fn: (tx: PubTx, step: OpStep, body: Body) => Promise<OperationOutput<T>>,
  ): Promise<T> {
    const body = bodyOf(raw);
    const p = productOf(ctx);
    const r = await this.ops.run<T>(
      {
        m: ctx.m,
        access: ctx.access,
        product: p,
        action,
        opKey: body.opKey,
        scope,
        pathParams: { pid: p.id, ...pathParams },
        body,
      },
      (tx, step) => fn(tx, step, body),
    );
    res.status(r.status);
    return r.body;
  }

  private leadOp(
    ctx: PubRequestCtx,
    action: PubAction,
    scope: string,
    id: string,
    raw: unknown,
    res: Response,
    run: (
      tx: PubTx,
      step: OpStep,
      body: Body,
    ) => Promise<{
      card: LeadCardView;
      audit: OperationOutput<LeadCardView>['audit'];
    }>,
  ): Promise<LeadCardView> {
    return this.mutate<LeadCardView>(
      ctx,
      action,
      scope,
      { id },
      raw,
      res,
      async (tx, step, body) => {
        const r = await run(tx, step, body);
        return { status: 200, body: r.card, audit: r.audit };
      },
    );
  }

  // ── Заявки ──────────────────────────────────────────────────────────────

  @Get('leads')
  @PubAllow('lead.read')
  async listLeads(
    @PubRequest() ctx: PubRequestCtx,
    @Query() q: Record<string, unknown>,
    @Res() res: Response,
  ): Promise<void> {
    // Список с выгрузкой отвечает сам (`@Res()`): перехватчик ответа
    // обернул бы файл в конверт; JSON — тот же конверт `{success, data, meta}`.
    const p = productOf(ctx);
    const now = new Date();
    if (q.format === 'csv') {
      const page = await this.leads.list(
        this.tenant(ctx),
        p.id,
        { ...q, limit: CSV_MAX_ROWS },
        now,
        {
          maxLimit: CSV_MAX_ROWS,
        },
      );
      await this.ops.recordRead(ctx.m, ctx.access, p, 'lead.read', {
        objectType: 'lead',
        objectId: p.id,
        action: 'export',
        meta: { format: 'csv', rows: page.items.length },
      });
      res
        .status(200)
        .set({
          'Content-Type': 'text/csv; charset=utf-8',
          'Cache-Control': PUB_NO_STORE,
          'Content-Disposition': 'attachment; filename="publisher-leads.csv"',
        })
        .send(toCsv(page.items, LEAD_CSV_COLUMNS));
      return;
    }
    if (q.format !== undefined && q.format !== 'json') {
      throw validationError([{ field: 'format', code: 'enum' }]);
    }
    const page = await this.leads.list(this.tenant(ctx), p.id, q, now);
    res
      .status(200)
      .setHeader('Cache-Control', PUB_NO_STORE)
      .json({
        success: true,
        data: page,
        meta: { timestamp: new Date().toISOString(), requestId: randomUUID() },
      });
  }

  @Get('leads/:id')
  @PubAllow('lead.read')
  async getLead(@PubRequest() ctx: PubRequestCtx, @Param('id') id: string) {
    const p = productOf(ctx);
    const db = this.tenant(ctx);
    const row = await this.leads.row(db, p.id, id);
    // Открытие карточки до обогащения — обогатить вне очереди (§11.4).
    if (!row.enrichedAt) await this.enrich.enrichNow(p, id);
    return this.leads.card(db, p.id, id, new Date());
  }

  @Post('leads/:id/transition')
  @PubAllow('lead.manage')
  transition(
    @PubRequest() ctx: PubRequestCtx,
    @Param('id') id: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.leadOp(
      ctx,
      'lead.manage',
      'lead.transition',
      id,
      raw,
      res,
      (tx, step, body) =>
        this.leads.transition(
          tx,
          productOf(ctx),
          actorsOf(ctx.access),
          id,
          body,
          step,
        ),
    );
  }

  @Post('leads/:id/assign')
  @PubAllow('lead.manage')
  assign(
    @PubRequest() ctx: PubRequestCtx,
    @Param('id') id: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.leadOp(
      ctx,
      'lead.manage',
      'lead.assign',
      id,
      raw,
      res,
      (tx, step, body) => this.leads.assign(tx, productOf(ctx), id, body, step),
    );
  }

  @Post('leads/:id/test-flag')
  @PubAllow('lead.test_flag')
  testFlag(
    @PubRequest() ctx: PubRequestCtx,
    @Param('id') id: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.leadOp(
      ctx,
      'lead.test_flag',
      'lead.test_flag',
      id,
      raw,
      res,
      (tx, step, body) =>
        this.leads.setTestFlag(tx, productOf(ctx), id, body, step),
    );
  }

  @Post('leads/:id/duplicate')
  @PubAllow('lead.manage')
  duplicate(
    @PubRequest() ctx: PubRequestCtx,
    @Param('id') id: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.leadOp(
      ctx,
      'lead.manage',
      'lead.duplicate',
      id,
      raw,
      res,
      (tx, step, body) =>
        this.leads.markDuplicate(tx, productOf(ctx), id, body, step),
    );
  }

  @Post('leads/:id/prospect')
  @PubAllow('lead.manage')
  setProspect(
    @PubRequest() ctx: PubRequestCtx,
    @Param('id') id: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.leadOp(
      ctx,
      'lead.manage',
      'lead.prospect',
      id,
      raw,
      res,
      (tx, step, body) =>
        this.leads.setProspect(tx, productOf(ctx), id, body, step),
    );
  }

  @Post('leads/:id/erase')
  @PubAllow('retention.manage')
  erase(
    @PubRequest() ctx: PubRequestCtx,
    @Param('id') id: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.leadOp(
      ctx,
      'retention.manage',
      'lead.erase',
      id,
      raw,
      res,
      (tx, step, body) => this.leads.erase(tx, productOf(ctx), id, body, step),
    );
  }

  @Post('leads/:id/retention')
  @PubAllow('retention.manage')
  retain(
    @PubRequest() ctx: PubRequestCtx,
    @Param('id') id: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.leadOp(
      ctx,
      'retention.manage',
      'lead.retain',
      id,
      raw,
      res,
      (tx, step, body) => this.leads.retain(tx, productOf(ctx), id, body, step),
    );
  }

  @Get('retention/due')
  @PubAllow('retention.manage')
  retentionDue(
    @PubRequest() ctx: PubRequestCtx,
    @Query('withinDays') within?: string,
  ) {
    const days = within === undefined ? 0 : Number(within);
    if (!Number.isInteger(days) || days < 0 || days > 90) {
      throw validationError([{ field: 'withinDays', code: 'range' }]);
    }
    return this.leads.retentionDue(
      this.tenant(ctx),
      productOf(ctx).id,
      days,
      new Date(),
    );
  }

  // ── Проспекты ───────────────────────────────────────────────────────────

  @Get('prospects')
  @PubAllow('lead.manage')
  listProspects(
    @PubRequest() ctx: PubRequestCtx,
    @Query() q: Record<string, unknown>,
  ) {
    return this.prospects.list(this.tenant(ctx), productOf(ctx).id, q);
  }

  @Post('prospects')
  @PubAllow('lead.manage')
  createProspect(
    @PubRequest() ctx: PubRequestCtx,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.mutate(
      ctx,
      'lead.manage',
      'prospect.create',
      {},
      raw,
      res,
      async (tx, step, body) => {
        for (const k of ['isExternal', 'isTeamOrPartner'] as const) {
          if (body[k] !== undefined && typeof body[k] !== 'boolean') {
            throw validationError([{ field: k, code: 'type' }]);
          }
        }
        const p = productOf(ctx);
        const created = await this.prospects.create(
          tx,
          p,
          {
            isExternal: body.isExternal as boolean | undefined,
            isTeamOrPartner: body.isTeamOrPartner as boolean | undefined,
            priorExternalPayment: body.priorExternalPayment as
              string | undefined,
            note: noteOf(body.note),
          },
          step.actor,
        );
        return {
          status: 201,
          body: await this.prospects.view(tx, p.id, created.id),
          audit: [
            {
              objectType: 'prospect',
              objectId: created.id,
              action: 'create',
              meta: { code: created.code },
            },
          ],
        };
      },
    );
  }

  @Post('prospects/merge')
  @PubAllow('lead.manage')
  mergeProspects(
    @PubRequest() ctx: PubRequestCtx,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.mutate(
      ctx,
      'lead.manage',
      'prospect.merge',
      {},
      raw,
      res,
      async (tx, step, body) => {
        const p = productOf(ctx);
        const reason = basisOf(body.reason, 'reason');
        const r = await this.prospects.merge(
          tx,
          p,
          body,
          step.actor,
          step.now,
          reason,
        );
        return {
          status: 200,
          body: await this.prospects.view(tx, p.id, r.intoId),
          audit: r.audit,
        };
      },
    );
  }

  @Patch('prospects/:prospectId')
  @PubAllow('lead.manage')
  updateProspect(
    @PubRequest() ctx: PubRequestCtx,
    @Param('prospectId') prospectId: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.mutate(
      ctx,
      'lead.manage',
      'prospect.update',
      { prospectId },
      raw,
      res,
      async (tx, _step, body) => {
        const p = productOf(ctx);
        const r = await this.prospects.update(tx, p, prospectId, body);
        return {
          status: 200,
          body: await this.prospects.view(tx, p.id, prospectId),
          audit: r.audit,
        };
      },
    );
  }

  // ── Оплаты клиентов ─────────────────────────────────────────────────────

  @Get('payments')
  @PubAllow('payment.manage')
  listPayments(
    @PubRequest() ctx: PubRequestCtx,
    @Query() q: Record<string, unknown>,
  ) {
    return this.payments.list(this.tenant(ctx), productOf(ctx).id, q);
  }

  @Post('payments')
  @PubAllow('payment.manage')
  createPayment(
    @PubRequest() ctx: PubRequestCtx,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.mutate(
      ctx,
      'payment.manage',
      'payment.create',
      {},
      raw,
      res,
      async (tx, step, body) => {
        const r = await this.payments.create(
          tx,
          productOf(ctx),
          body,
          String(body.opKey),
          step.actor,
        );
        return { status: 201, body: r.view, audit: r.audit };
      },
    );
  }

  @Post('payments/:paymentId/confirm')
  @PubAllow('payment.manage')
  confirmPayment(
    @PubRequest() ctx: PubRequestCtx,
    @Param('paymentId') paymentId: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.paymentTo(ctx, paymentId, 'confirmed', raw, res);
  }

  @Post('payments/:paymentId/refund')
  @PubAllow('payment.manage')
  refundPayment(
    @PubRequest() ctx: PubRequestCtx,
    @Param('paymentId') paymentId: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.paymentTo(ctx, paymentId, 'refunded', raw, res);
  }

  @Post('payments/:paymentId/cancel')
  @PubAllow('payment.manage')
  cancelPayment(
    @PubRequest() ctx: PubRequestCtx,
    @Param('paymentId') paymentId: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.paymentTo(ctx, paymentId, 'cancelled', raw, res);
  }

  private paymentTo(
    ctx: PubRequestCtx,
    paymentId: string,
    to: 'confirmed' | 'refunded' | 'cancelled',
    raw: unknown,
    res: Response,
  ) {
    return this.mutate(
      ctx,
      'payment.manage',
      `payment.${to}`,
      { paymentId },
      raw,
      res,
      async (tx, step, body) => {
        const r = await this.payments.transition(
          tx,
          productOf(ctx),
          paymentId,
          to,
          body,
          step.actor,
          step.now,
        );
        return { status: 200, body: r.view, audit: r.audit };
      },
    );
  }

  // ── Уведомления, очередь обогащения, отметка проверки ──────────────────

  @Get('notifications')
  @PubAllow('lead.manage')
  listNotifications(
    @PubRequest() ctx: PubRequestCtx,
    @Query() q: Record<string, unknown>,
  ) {
    return this.notifications.list(this.tenant(ctx), productOf(ctx).id, q);
  }

  @Post('notifications/:notificationId/retry')
  @PubAllow('lead.manage')
  retryNotification(
    @PubRequest() ctx: PubRequestCtx,
    @Param('notificationId') notificationId: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.mutate(
      ctx,
      'lead.manage',
      'notification.retry',
      { notificationId },
      raw,
      res,
      async (tx, step) => {
        const r = await this.notifications.retry(
          tx,
          productOf(ctx).id,
          notificationId,
          step.now,
        );
        return { status: 200, body: r.view, audit: r.audit };
      },
    );
  }

  @Get('lead-outbox')
  @PubAllow('lead.manage')
  listOutbox(
    @PubRequest() ctx: PubRequestCtx,
    @Query() q: Record<string, unknown>,
  ) {
    return this.notifications.outbox(this.tenant(ctx), productOf(ctx).id, q);
  }

  @Post('queue-checks')
  @PubAllow('queue.check')
  createQueueCheck(
    @PubRequest() ctx: PubRequestCtx,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.mutate(
      ctx,
      'queue.check',
      'queue.check',
      {},
      raw,
      res,
      async (tx, step) => {
        const r = await this.queueChecks.check(
          tx,
          productOf(ctx),
          step.actor,
          step.now,
        );
        return { status: r.status, body: r.view, audit: r.audit };
      },
    );
  }

  @Get('queue-checks')
  @PubAllow('queue.check')
  listQueueChecks(
    @PubRequest() ctx: PubRequestCtx,
    @Query() q: Record<string, unknown>,
  ) {
    return this.queueChecks.list(
      this.tenant(ctx),
      productOf(ctx).id,
      q,
      new Date(),
    );
  }

  // ── Паспорт трафика F11 ────────────────────────────────────────────────

  @Get('traffic/passport')
  @PubAllow('traffic.read')
  passport(
    @PubRequest() ctx: PubRequestCtx,
    @Query() q: Record<string, unknown>,
  ) {
    return this.traffic.passport(this.tenant(ctx), productOf(ctx), q);
  }

  @Get('traffic/events')
  @PubAllow('traffic.diagnostics')
  async trafficEvents(
    @PubRequest() ctx: PubRequestCtx,
    @Query() q: Record<string, unknown>,
  ) {
    const p = productOf(ctx);
    const test = q.test ?? 'include';
    if (!['include', 'exclude', 'only'].includes(String(test))) {
      throw validationError([{ field: 'test', code: 'enum' }]);
    }
    const limit = Math.min(Math.max(Number(q.limit ?? 50) || 50, 1), 100);
    const db = this.tenant(ctx);
    const where: Record<string, unknown> = {
      productId: p.id,
      ...(test === 'exclude'
        ? { testFlag: false }
        : test === 'only'
          ? { testFlag: true }
          : {}),
      ...(typeof q.name === 'string' && q.name ? { name: q.name } : {}),
    };
    if (typeof q.before === 'string' && q.before) {
      const c = await db.pubEvent.findFirst({
        where: { id: q.before, productId: p.id },
        select: { id: true, occurredAt: true },
      });
      if (c)
        where.OR = [
          { occurredAt: { lt: c.occurredAt } },
          { occurredAt: c.occurredAt, id: { lt: c.id } },
        ];
    }
    const rows = await db.pubEvent.findMany({
      where,
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    return {
      items: page.map((e) => ({
        id: e.id,
        eventId: e.eventId,
        name: e.name,
        occurredAt: e.occurredAt.toISOString(),
        contentSlugRaw: e.contentSlugRaw,
        placementCodeRaw: e.placementCodeRaw,
        referrerHost: e.referrerHost,
        sessionRef: e.sessionRef,
        utm: (e.utm as Record<string, string> | null) ?? null,
        utmRedacted: e.utmRedacted,
        contentId: e.contentId,
        placementId: e.placementId,
        channelGroup: e.channelGroup,
        leadId: e.leadId,
        testFlag: e.testFlag,
        enrichedAt: e.enrichedAt?.toISOString() ?? null,
      })),
      nextBefore: rows.length > limit ? page[page.length - 1].id : null,
    };
  }
}
