/**
 * AI Publisher, P-B1 — маршруты кабинета: брифы F03, материалы и
 * адаптации, версии (diff, отправка), переходы машины 7.1, claims F04,
 * QA-проверки и согласование hash (проектный документ §11.3; контракт
 * `contracts/content-api.ts`).
 */
import { Body, Get, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { SitesDb } from '../../../prisma/sites-db.service';
import type {
  BriefView,
  ClaimView,
  ContentView,
} from '../contracts/content-api';
import {
  BRIEF_STATUSES,
  CLAIM_STATUSES,
  CONTENT_KINDS,
  CONTENT_STATUSES,
} from '../contracts/states';
import { memberActor } from '../contracts/common';
import { PubError, validationError } from '../core/errors';
import type { PubTx } from '../core/ports';
import { PubOperations } from '../core/operation';
import {
  PubAllow,
  PubCabinetController,
  PubRequest,
  type PubRequestCtx,
} from '../core/pub-role.guard';
import { ApprovalsPublishService } from './approvals-publish.service';
import { BriefsService } from './briefs.service';
import { ClaimsService } from './claims.service';
import {
  ContentControllerBase,
  actorsOf,
  productOf,
} from './content-base.controller';
import { ContentsService } from './contents.service';
import {
  clampLimit,
  csvOf,
  formatOf,
  pageOf,
  sendCsv,
  sendEnvelope,
} from './http';
import { bodyOf, limitOf, strQ } from './input';
import { QaChecksService, QA_ACTION } from './qa-checks.service';
import { can } from '../core/roles';
import { loadBrief, loadClaim, loadContent, loadVersion } from './views';

function enumQ<T extends string>(
  v: unknown,
  list: readonly T[],
  field: string,
): T | undefined {
  const s = strQ(v);
  if (s === undefined) return undefined;
  if (!(list as readonly string[]).includes(s))
    throw validationError([{ field, code: 'enum' }]);
  return s as T;
}

@PubCabinetController('products/:pid')
export class ContentMaterialsController extends ContentControllerBase {
  constructor(
    db: SitesDb,
    ops: PubOperations,
    private readonly briefs: BriefsService,
    private readonly contents: ContentsService,
    private readonly claims: ClaimsService,
    private readonly qa: QaChecksService,
    private readonly approvals: ApprovalsPublishService,
  ) {
    super(db, ops);
  }

  // ── Брифы F03 ──────────────────────────────────────────────────────────

  @Get('briefs')
  @PubAllow('product.read')
  async listBriefs(
    @PubRequest() ctx: PubRequestCtx,
    @Query() q: Record<string, unknown>,
    @Res() res: Response,
  ) {
    const p = productOf(ctx);
    const csv = formatOf(q.format) === 'csv';
    const status = enumQ(q.status, BRIEF_STATUSES, 'status');
    const limit = clampLimit(limitOf(q.limit), csv);
    const before = strQ(q.before);
    const db = this.tenant(ctx);
    const rows = await db.pubBrief.findMany({
      where: {
        productId: p.id,
        ...(status ? { status } : {}),
        ...(before ? { id: { lt: before } } : {}),
      },
      orderBy: { id: 'desc' },
      take: limit + 1,
      select: { id: true },
    });
    const views: BriefView[] = [];
    for (const r of rows) views.push(await loadBrief(db, p.id, r.id));
    const page = pageOf(views, limit);
    if (!csv) return sendEnvelope(res, page);
    await this.ops.recordRead(ctx.m, ctx.access, p, 'product.read', {
      objectType: 'product',
      objectId: p.id,
      action: 'export',
      meta: { list: 'briefs', count: page.items.length },
    });
    sendCsv(
      res,
      'briefs',
      csvOf<BriefView>(page.items, [
        ['id', (x) => x.id],
        ['questionId', (x) => x.questionId],
        ['offerVersionId', (x) => x.offerVersionId],
        ['format', (x) => x.format],
        ['goal', (x) => x.goal],
        ['cta', (x) => x.cta],
        ['status', (x) => x.status],
        ['missing', (x) => x.missing.join(' ')],
      ]),
    );
  }

  @Get('briefs/:id')
  @PubAllow('product.read')
  async getBrief(@PubRequest() ctx: PubRequestCtx, @Param('id') id: string) {
    return loadBrief(this.tenant(ctx), productOf(ctx).id, id);
  }

  @Post('briefs')
  @PubAllow('brief.manage')
  async createBrief(
    @PubRequest() ctx: PubRequestCtx,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const b = bodyOf(raw);
    const p = productOf(ctx);
    return this.run(
      ctx,
      res,
      'brief.manage',
      'brief.create',
      { pid: p.id },
      b,
      (tx, s) => this.briefs.create(tx, p, b, s.actor, actorsOf(ctx.access)),
      { status: 201 },
    );
  }

  @Patch('briefs/:id')
  @PubAllow('brief.manage')
  async patchBrief(
    @PubRequest() ctx: PubRequestCtx,
    @Param('id') id: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const b = bodyOf(raw);
    const p = productOf(ctx);
    return this.run(
      ctx,
      res,
      'brief.manage',
      'brief.update',
      { pid: p.id, id },
      b,
      (tx, s) => this.briefs.patch(tx, p, id, b, s.actor),
    );
  }

  @Post('briefs/:id/ready')
  @PubAllow('brief.manage')
  async briefReady(
    @PubRequest() ctx: PubRequestCtx,
    @Param('id') id: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const b = bodyOf(raw);
    const p = productOf(ctx);
    return this.run(
      ctx,
      res,
      'brief.manage',
      'brief.ready',
      { pid: p.id, id },
      b,
      (tx) => this.briefs.ready(tx, p, id, b),
    );
  }

  // ── Материалы ──────────────────────────────────────────────────────────

  @Get('contents')
  @PubAllow('product.read')
  async listContents(
    @PubRequest() ctx: PubRequestCtx,
    @Query() q: Record<string, unknown>,
    @Res() res: Response,
  ) {
    const p = productOf(ctx);
    const csv = formatOf(q.format) === 'csv';
    const status = enumQ(q.status, CONTENT_STATUSES, 'status');
    const kind = enumQ(q.kind, CONTENT_KINDS, 'kind');
    const owner = strQ(q.owner);
    const parentContentId = strQ(q.parentContentId);
    const limit = clampLimit(limitOf(q.limit), csv);
    const before = strQ(q.before);
    const db = this.tenant(ctx);
    const rows = await db.pubContent.findMany({
      where: {
        productId: p.id,
        ...(status ? { status } : {}),
        ...(kind ? { kind } : {}),
        ...(owner ? { ownerMemberId: owner } : {}),
        ...(parentContentId ? { parentContentId } : {}),
        ...(before ? { id: { lt: before } } : {}),
      },
      orderBy: { id: 'desc' },
      take: limit + 1,
      select: { id: true },
    });
    const views: ContentView[] = [];
    for (const r of rows) views.push(await loadContent(db, p.id, r.id));
    const page = pageOf(views, limit);
    if (!csv) return sendEnvelope(res, page);
    await this.ops.recordRead(ctx.m, ctx.access, p, 'product.read', {
      objectType: 'product',
      objectId: p.id,
      action: 'export',
      meta: { list: 'contents', count: page.items.length },
    });
    sendCsv(
      res,
      'contents',
      csvOf<ContentView>(page.items, [
        ['id', (x) => x.id],
        ['kind', (x) => x.kind],
        ['slug', (x) => x.slug],
        ['status', (x) => x.status],
        ['parentContentId', (x) => x.parentContentId],
        ['publishedVersionId', (x) => x.publishedVersionId],
        ['criticalStale', (x) => x.criticalStale],
        ['firstPublishedAt', (x) => x.firstPublishedAt],
        ['nextDueAt', (x) => x.nextDueAt],
        ['openTasks', (x) => x.openTasks.length],
      ]),
    );
  }

  @Post('contents')
  @PubAllow('version.manage')
  async createContent(
    @PubRequest() ctx: PubRequestCtx,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const b = bodyOf(raw);
    const p = productOf(ctx);
    return this.run(
      ctx,
      res,
      'version.manage',
      'content.create',
      { pid: p.id },
      b,
      (tx, s) => this.contents.create(tx, p, b, s.actor),
      { status: 201 },
    );
  }

  @Get('contents/:cid')
  @PubAllow('product.read')
  async getContent(
    @PubRequest() ctx: PubRequestCtx,
    @Param('cid') cid: string,
  ) {
    return loadContent(this.tenant(ctx), productOf(ctx).id, cid);
  }

  @Patch('contents/:cid')
  @PubAllow('version.manage')
  async patchContent(
    @PubRequest() ctx: PubRequestCtx,
    @Param('cid') cid: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const b = bodyOf(raw);
    const p = productOf(ctx);
    return this.run(
      ctx,
      res,
      'version.manage',
      'content.update',
      { pid: p.id, cid },
      b,
      (tx) => this.contents.patch(tx, p, cid, b),
    );
  }

  @Get('contents/:cid/versions')
  @PubAllow('product.read')
  async listVersions(
    @PubRequest() ctx: PubRequestCtx,
    @Param('cid') cid: string,
  ) {
    const p = productOf(ctx);
    const db = this.tenant(ctx);
    await loadContent(db, p.id, cid);
    const rows = await db.pubContentVersion.findMany({
      where: { productId: p.id, contentId: cid },
      orderBy: { number: 'desc' },
      select: { id: true },
    });
    const items = [];
    for (const r of rows) items.push(await loadVersion(db, p.id, r.id, cid));
    return { items };
  }

  @Get('contents/:cid/versions/:vid')
  @PubAllow('product.read')
  async getVersion(
    @PubRequest() ctx: PubRequestCtx,
    @Param('cid') cid: string,
    @Param('vid') vid: string,
  ) {
    return loadVersion(this.tenant(ctx), productOf(ctx).id, vid, cid);
  }

  @Get('contents/:cid/versions/:a/diff/:b')
  @PubAllow('product.read')
  async diff(
    @PubRequest() ctx: PubRequestCtx,
    @Param('cid') cid: string,
    @Param('a') a: string,
    @Param('b') bId: string,
  ) {
    return this.contents.diff(this.tenant(ctx), productOf(ctx).id, cid, a, bId);
  }

  @Post('contents/:cid/versions')
  @PubAllow('version.manage')
  async createVersion(
    @PubRequest() ctx: PubRequestCtx,
    @Param('cid') cid: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const b = bodyOf(raw);
    const p = productOf(ctx);
    return this.run(
      ctx,
      res,
      'version.manage',
      'version.create',
      { pid: p.id, cid },
      b,
      (tx, s) =>
        this.contents.createVersion(
          tx,
          p,
          cid,
          b,
          {
            memberId: ctx.m.memberId,
            actor: s.actor,
            actors: actorsOf(ctx.access),
          },
          s.now,
        ),
      { status: 201 },
    );
  }

  @Patch('contents/:cid/versions/:vid')
  @PubAllow('version.manage')
  async patchVersion(
    @PubRequest() ctx: PubRequestCtx,
    @Param('cid') cid: string,
    @Param('vid') vid: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const b = bodyOf(raw);
    const p = productOf(ctx);
    return this.run(
      ctx,
      res,
      'version.manage',
      'version.update',
      { pid: p.id, cid, vid },
      b,
      (tx, s) => this.contents.patchVersion(tx, p, cid, vid, b, s.actor),
    );
  }

  @Post('contents/:cid/versions/:vid/submit')
  @PubAllow('version.manage')
  async submitVersion(
    @PubRequest() ctx: PubRequestCtx,
    @Param('cid') cid: string,
    @Param('vid') vid: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const b = bodyOf(raw);
    const p = productOf(ctx);
    return this.run(
      ctx,
      res,
      'version.manage',
      'version.submit',
      { pid: p.id, cid, vid },
      b,
      (tx, s) =>
        this.contents.submit(tx, p, cid, vid, b, actorsOf(ctx.access), s.now),
    );
  }

  @Post('contents/:cid/transition')
  @PubAllow('version.manage', 'publication.manage')
  async transition(
    @PubRequest() ctx: PubRequestCtx,
    @Param('cid') cid: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const b = bodyOf(raw);
    const p = productOf(ctx);
    // Роль конкретного перехода решает машина 7.1 (`assertTransition`);
    // ключ идемпотентности — под тем действием матрицы, которое есть.
    const action = can(ctx.access, 'version.manage')
      ? 'version.manage'
      : 'publication.manage';
    return this.run(
      ctx,
      res,
      action,
      'content.transition',
      { pid: p.id, cid },
      b,
      (tx, s) =>
        this.contents.transition(tx, p, cid, b, actorsOf(ctx.access), s.now),
    );
  }

  // ── Claims F04 ─────────────────────────────────────────────────────────

  @Get('claims')
  @PubAllow('product.read')
  async listClaims(
    @PubRequest() ctx: PubRequestCtx,
    @Query() q: Record<string, unknown>,
    @Res() res: Response,
  ) {
    const p = productOf(ctx);
    const csv = formatOf(q.format) === 'csv';
    const status = enumQ(q.status, CLAIM_STATUSES, 'status');
    const versionId = strQ(q.versionId);
    const limit = clampLimit(limitOf(q.limit), csv);
    const before = strQ(q.before);
    const db = this.tenant(ctx);
    const rows = await db.pubClaim.findMany({
      where: {
        productId: p.id,
        ...(status ? { status } : {}),
        ...(versionId ? { versionClaimClaimOf: { some: { versionId } } } : {}),
        ...(before ? { id: { lt: before } } : {}),
      },
      orderBy: { id: 'desc' },
      take: limit + 1,
      select: { id: true },
    });
    const views: ClaimView[] = [];
    for (const r of rows) views.push(await loadClaim(db, p.id, r.id));
    const page = pageOf(views, limit);
    if (!csv) return sendEnvelope(res, page);
    await this.ops.recordRead(ctx.m, ctx.access, p, 'product.read', {
      objectType: 'product',
      objectId: p.id,
      action: 'export',
      meta: { list: 'claims', count: page.items.length },
    });
    sendCsv(
      res,
      'claims',
      csvOf<ClaimView>(page.items, [
        ['id', (x) => x.id],
        ['statement', (x) => x.statement],
        ['type', (x) => x.type],
        ['risk', (x) => x.risk],
        ['status', (x) => x.status],
        ['supersedesId', (x) => x.supersedesId],
        ['verifiedAt', (x) => x.verifiedAt],
        [
          'sources',
          (x) => x.sources.map((s) => `${s.sourceId}:${s.supports}`).join(' '),
        ],
      ]),
    );
  }

  @Post('claims')
  @PubAllow('version.manage')
  async createClaim(
    @PubRequest() ctx: PubRequestCtx,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const b = bodyOf(raw);
    const p = productOf(ctx);
    return this.run(
      ctx,
      res,
      'version.manage',
      'claim.create',
      { pid: p.id },
      b,
      (tx, s) => this.claims.create(tx, p, b, s.actor, actorsOf(ctx.access)),
      { status: 201 },
    );
  }

  @Patch('claims/:id')
  @PubAllow('version.manage')
  async patchClaim(
    @PubRequest() ctx: PubRequestCtx,
    @Param('id') id: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const b = bodyOf(raw);
    const p = productOf(ctx);
    return this.run(
      ctx,
      res,
      'version.manage',
      'claim.update',
      { pid: p.id, id },
      b,
      (tx, s) => this.claims.patch(tx, p, id, b, s.actor, s.now),
    );
  }

  @Post('claims/:id/sources')
  @PubAllow('claim.verify')
  async claimSource(
    @PubRequest() ctx: PubRequestCtx,
    @Param('id') id: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const b = bodyOf(raw);
    const p = productOf(ctx);
    return this.run(
      ctx,
      res,
      'claim.verify',
      'claim.source',
      { pid: p.id, id },
      b,
      (tx, s) => this.claims.linkSource(tx, p, id, b, s.actor, s.now),
    );
  }

  @Post('claims/:id/verify')
  @PubAllow('claim.verify')
  async verifyClaim(
    @PubRequest() ctx: PubRequestCtx,
    @Param('id') id: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const b = bodyOf(raw);
    const p = productOf(ctx);
    return this.run(
      ctx,
      res,
      'claim.verify',
      'claim.verify',
      { pid: p.id, id },
      b,
      (tx, s) => this.claims.verify(tx, p, id, b, ctx.access, s.actor, s.now),
    );
  }

  // ── QA и согласование ──────────────────────────────────────────────────

  @Get('versions/:vid/qa-checks')
  @PubAllow('product.read')
  async listQa(@PubRequest() ctx: PubRequestCtx, @Param('vid') vid: string) {
    return this.qa.list(this.tenant(ctx), productOf(ctx).id, vid);
  }

  @Post('versions/:vid/qa-checks')
  @PubAllow('qa.editorial', 'qa.technical')
  async qaCheck(
    @PubRequest() ctx: PubRequestCtx,
    @Param('vid') vid: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const b = bodyOf(raw);
    const p = productOf(ctx);
    const kind = b.kind as keyof typeof QA_ACTION;
    const action = QA_ACTION[kind] ?? 'qa.editorial';
    return this.run(
      ctx,
      res,
      action,
      'qa.create',
      { pid: p.id, vid },
      b,
      (tx, s) => this.qa.create(tx, p, vid, b, ctx.access, s.actor, s.now),
      { status: 201 },
    );
  }

  @Post('versions/:vid/approve')
  @PubAllow('version.approve')
  async approve(
    @PubRequest() ctx: PubRequestCtx,
    @Param('vid') vid: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const b = bodyOf(raw);
    const p = productOf(ctx);
    try {
      return await this.run(
        ctx,
        res,
        'version.approve',
        'version.approve',
        { pid: p.id, vid },
        b,
        (tx, s) =>
          this.approvals.approve(
            tx,
            p,
            vid,
            b,
            {
              memberId: ctx.m.memberId,
              access: ctx.access,
              actors: actorsOf(ctx.access),
            },
            s.now,
          ),
        { status: 201 },
      );
    } catch (e) {
      // P-R M2, раунд 4 (аудит экранов S2-1): набор WARN изменился — свежая
      // проверка `reddit_policy` сохраняется, клиент подтверждает её состав.
      if (
        e instanceof PubError &&
        e.code === 'PUB_CONFLICT' &&
        e.details.reason === 'warnings_not_acknowledged'
      ) {
        const kept = await this.db
          .forAccount(ctx.m.accountId)
          .$transaction((tx) =>
            this.approvals.keepPolicyCheck(
              tx as unknown as PubTx,
              p,
              vid,
              memberActor(ctx.m.memberId),
              new Date(),
            ),
          );
        throw new PubError('PUB_CONFLICT', {
          reason: 'warnings_not_acknowledged',
          ...kept,
        });
      }
      throw e;
    }
  }

  @Get('approvals')
  @PubAllow('product.read')
  async listApprovals(
    @PubRequest() ctx: PubRequestCtx,
    @Query() q: Record<string, unknown>,
  ) {
    return this.approvals.list(this.tenant(ctx), productOf(ctx).id, {
      objectId: strQ(q.objectId),
      status: strQ(q.status),
    });
  }

  @Post('approvals/:id/revoke')
  @PubAllow('approval.revoke')
  async revokeApproval(
    @PubRequest() ctx: PubRequestCtx,
    @Param('id') id: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const b = bodyOf(raw);
    const p = productOf(ctx);
    return this.run(
      ctx,
      res,
      'approval.revoke',
      'approval.revoke',
      { pid: p.id, id },
      b,
      (tx, s) =>
        this.approvals.revoke(tx, p, id, b, actorsOf(ctx.access), s.now),
    );
  }
}
