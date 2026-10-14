/**
 * AI Publisher, P-R — маршруты раздела Reddit, этап M1 Research
 * (reddit-manual-mvp-adapted.md §M1.5; контракт `contracts/reddit-api.ts`
 * `REDDIT_ROUTES`). Префикс `/publisher/products/:pid/reddit/**` (Р-RD-13):
 * изоляция кабинета и продукта, роли — `PubRoleGuard`; мутации —
 * `PubOperations.run` (идемпотентность по `opKey`, CAS по
 * `expectedRevision`, аудит в транзакции, `mapDbError`); чтения `opKey` не
 * принимают. Первый гвард — `RedditEnabledGuard` (флаг выключен → 404 без
 * `details`, AT-RD-17).
 *
 * Сети нет ни в одном маршруте (Р-RD-0, AT-RD-16): Reddit не запрашивается,
 * URL только хранятся (правило графа `publisher-reddit-no-network`).
 */
import {
  Body,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { SitesDb } from '../../../prisma/sites-db.service';
import { REDDIT_CSV_COLUMNS } from '../contracts/reddit-api';
import { PubOperations } from '../core/operation';
import {
  PubAllow,
  PubCabinetController,
  PubRequest,
  type PubRequestCtx,
} from '../core/pub-role.guard';
import type { PubAction } from '../core/roles';
import {
  formatOf,
  limitOf,
  mutate,
  type MutationSpec,
  pageOf,
  productOf,
  sendCsv,
  sendEnvelope,
} from '../distribution/http';
import { toCsv } from '../distribution/input';
import { jsonSafe } from '../core/money';
import { RedditCommunitiesService } from './communities.service';
import {
  LIST_STATUSES,
  communityCsvRow,
  listCommunities,
  listKeywords,
  listOpportunities,
  listParams,
  listProjects,
  opportunityCsvRow,
} from './lists';
import { RedditOpportunitiesService } from './opportunities.service';
import { RedditProjectsService } from './projects.service';
import { RedditEnabledGuard } from './reddit-flag.guard';
import { RedditMaterialsService } from '../content/reddit-materials.service';
import { loadBriefView, loadMaterialView } from './brief-views';
import { RedditBriefsService } from './briefs.service';
import { RedditGenerateService } from './generate.service';
import { RedditHandoffService } from './handoff.service';
import {
  briefCsvRow,
  briefListParams,
  listBriefs,
  listPublications,
  publicationCsvRow,
  publicationListParams,
} from './lists-m2';
import { bodyOf } from '../distribution/input';
import { actorsOf } from '../distribution/placements.service';
import {
  communityRow,
  loadCommunityView,
  loadOpportunityView,
  opportunityExcerpts,
  projectRow,
  projectView,
  rulesSource,
  snapshotView,
  staleDaysFor,
} from './views';

const R = 'products/:pid/reddit';
const READ: PubAction = 'reddit.read';
const MANAGE: PubAction = 'reddit.manage';

type Q = Record<string, unknown>;

@PubCabinetController()
@UseGuards(RedditEnabledGuard)
export class PublisherRedditController {
  constructor(
    private readonly db: SitesDb,
    private readonly ops: PubOperations,
    private readonly projects: RedditProjectsService,
    private readonly communities: RedditCommunitiesService,
    private readonly opportunities: RedditOpportunitiesService,
    private readonly briefs: RedditBriefsService,
    private readonly materials: RedditMaterialsService,
    private readonly generator: RedditGenerateService,
    private readonly handoff: RedditHandoffService,
  ) {}

  private tenant(ctx: PubRequestCtx) {
    return this.db.forAccount(ctx.m.accountId);
  }

  /**
   * Ответ списка: JSON-страница или CSV (аудит `export` до отдачи файла —
   * отдельной короткой транзакцией `recordRead`).
   */
  private async respond<T extends { id: string }>(
    res: Response,
    ctx: PubRequestCtx,
    name: keyof typeof REDDIT_CSV_COLUMNS,
    csv: boolean,
    rows: T[],
    limit: number,
    toRow: (r: T) => Record<string, unknown> = (r) =>
      jsonSafe(r) as Record<string, unknown>,
  ): Promise<void> {
    if (!csv) {
      sendEnvelope(res, pageOf(rows, limit));
      return;
    }
    const p = productOf(ctx);
    await this.ops.recordRead(ctx.m, ctx.access, p, READ, {
      objectType: 'product',
      objectId: p.id,
      action: 'export',
      meta: { list: `reddit-${name}`, rows: rows.length },
    });
    sendCsv(
      res,
      `reddit-${name}`,
      toCsv(REDDIT_CSV_COLUMNS[name], rows.map(toRow)),
    );
  }

  private paging(q: Q, statuses: readonly string[], withPolicyNow = false) {
    const csv = formatOf(q.format) === 'csv';
    const limit = limitOf(q.limit, csv);
    return {
      csv,
      limit,
      p: listParams(q, statuses, csv ? limit : limit + 1, withPolicyNow),
    };
  }

  private run<T>(
    res: Response,
    ctx: PubRequestCtx,
    action: PubAction,
    scope: string,
    pathParams: Record<string, string>,
    raw: unknown,
    status: number,
    fn: MutationSpec<T>['fn'],
  ): Promise<T> {
    return mutate<T>(res, {
      ops: this.ops,
      ctx,
      action,
      scope,
      pathParams: { pid: productOf(ctx).id, ...pathParams },
      raw,
      status,
      fn,
    });
  }

  // ── Проекты ────────────────────────────────────────────────────────────

  @Get(`${R}/projects`)
  @PubAllow(READ)
  async listProjects(
    @PubRequest() ctx: PubRequestCtx,
    @Query() q: Q,
    @Res() res: Response,
  ): Promise<void> {
    const { csv, limit, p } = this.paging(q, LIST_STATUSES.projects);
    const rows = await listProjects(this.tenant(ctx), productOf(ctx).id, p);
    await this.respond(res, ctx, 'projects', csv, rows, limit);
  }

  @Post(`${R}/projects`)
  @PubAllow(MANAGE)
  createProject(
    @PubRequest() ctx: PubRequestCtx,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.run(
      res,
      ctx,
      MANAGE,
      'reddit.project.create',
      {},
      raw,
      201,
      (tx, step, b) => this.projects.create(tx, productOf(ctx), b, step.actor),
    );
  }

  @Get(`${R}/projects/:id`)
  @PubAllow(READ)
  async getProject(@PubRequest() ctx: PubRequestCtx, @Param('id') id: string) {
    return projectView(
      await projectRow(this.tenant(ctx), productOf(ctx).id, id),
    );
  }

  @Patch(`${R}/projects/:id`)
  @PubAllow(MANAGE)
  patchProject(
    @PubRequest() ctx: PubRequestCtx,
    @Param('id') id: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.run(
      res,
      ctx,
      MANAGE,
      'reddit.project.update',
      { id },
      raw,
      200,
      (tx, _step, b) => this.projects.patch(tx, productOf(ctx), id, b),
    );
  }

  @Post(`${R}/projects/:id/archive`)
  @PubAllow(MANAGE)
  archiveProject(
    @PubRequest() ctx: PubRequestCtx,
    @Param('id') id: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.run(
      res,
      ctx,
      MANAGE,
      'reddit.project.archive',
      { id },
      raw,
      200,
      (tx, _step, b) => this.projects.archive(tx, productOf(ctx), id, b),
    );
  }

  // ── Сообщества ─────────────────────────────────────────────────────────

  @Get(`${R}/communities`)
  @PubAllow(READ)
  async listCommunities(
    @PubRequest() ctx: PubRequestCtx,
    @Query() q: Q,
    @Res() res: Response,
  ): Promise<void> {
    const { csv, limit, p } = this.paging(q, LIST_STATUSES.communities);
    const rows = await listCommunities(
      this.tenant(ctx),
      productOf(ctx).id,
      p,
      new Date(),
    );
    await this.respond(
      res,
      ctx,
      'communities',
      csv,
      rows,
      limit,
      communityCsvRow,
    );
  }

  @Post(`${R}/communities`)
  @PubAllow(MANAGE)
  createCommunity(
    @PubRequest() ctx: PubRequestCtx,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.run(
      res,
      ctx,
      MANAGE,
      'reddit.community.create',
      {},
      raw,
      201,
      (tx, step, b) => this.communities.create(tx, productOf(ctx), step, b),
    );
  }

  @Get(`${R}/communities/:id`)
  @PubAllow(READ)
  getCommunity(@PubRequest() ctx: PubRequestCtx, @Param('id') id: string) {
    return loadCommunityView(
      this.tenant(ctx),
      productOf(ctx).id,
      id,
      new Date(),
    );
  }

  @Patch(`${R}/communities/:id`)
  @PubAllow(MANAGE)
  patchCommunity(
    @PubRequest() ctx: PubRequestCtx,
    @Param('id') id: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.run(
      res,
      ctx,
      MANAGE,
      'reddit.community.update',
      { id },
      raw,
      200,
      (tx, step, b) => this.communities.patch(tx, productOf(ctx), id, step, b),
    );
  }

  // ── Правила ────────────────────────────────────────────────────────────

  @Get(`${R}/communities/:id/rules`)
  @PubAllow(READ)
  async listRules(@PubRequest() ctx: PubRequestCtx, @Param('id') id: string) {
    const db = this.tenant(ctx);
    const pid = productOf(ctx).id;
    await communityRow(db, pid, id);
    const snaps = await db.pubRedditRuleSnapshot.findMany({
      where: { productId: pid, communityId: id },
      orderBy: { version: 'desc' },
    });
    const sources = await db.pubSource.findMany({
      where: { productId: pid, id: { in: snaps.map((s) => s.sourceId) } },
    });
    const src = new Map(sources.map((s) => [s.id, s]));
    const now = new Date();
    const staleDays = await staleDaysFor(db, pid);
    return {
      items: snaps
        .filter((s) => src.has(s.sourceId))
        .map((s) => snapshotView(s, src.get(s.sourceId)!, now, staleDays)),
      nextBefore: null,
    };
  }

  /** Первоисточник снимка (и `superseded`) — для отзыва (UI-аудит S2-2). */
  @Get(`${R}/communities/:id/rules/:sid/source`)
  @PubAllow(READ)
  getRulesSource(
    @PubRequest() ctx: PubRequestCtx,
    @Param('id') id: string,
    @Param('sid') sid: string,
  ) {
    return rulesSource(this.tenant(ctx), productOf(ctx).id, id, sid);
  }

  @Post(`${R}/communities/:id/rules`)
  @PubAllow(MANAGE)
  createRules(
    @PubRequest() ctx: PubRequestCtx,
    @Param('id') id: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.run(
      res,
      ctx,
      MANAGE,
      'reddit.rules.create',
      { id },
      raw,
      201,
      (tx, step, b) =>
        this.communities.createRules(tx, productOf(ctx), id, step, b),
    );
  }

  @Post(`${R}/rules/:id/review`)
  @PubAllow('reddit.rules.review')
  reviewRules(
    @PubRequest() ctx: PubRequestCtx,
    @Param('id') id: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.run(
      res,
      ctx,
      'reddit.rules.review',
      'reddit.rules.review',
      { id },
      raw,
      200,
      (tx, step, b) =>
        this.communities.review(tx, productOf(ctx), ctx.access, id, step, b),
    );
  }

  // ── Возможности ────────────────────────────────────────────────────────

  @Get(`${R}/opportunities`)
  @PubAllow(READ)
  async listOpportunities(
    @PubRequest() ctx: PubRequestCtx,
    @Query() q: Q,
    @Res() res: Response,
  ): Promise<void> {
    const { csv, limit, p } = this.paging(q, LIST_STATUSES.opportunities, true);
    const rows = await listOpportunities(
      this.tenant(ctx),
      productOf(ctx).id,
      p,
    );
    await this.respond(
      res,
      ctx,
      'opportunities',
      csv,
      rows,
      limit,
      opportunityCsvRow,
    );
  }

  @Post(`${R}/opportunities`)
  @PubAllow(MANAGE)
  createOpportunity(
    @PubRequest() ctx: PubRequestCtx,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.run(
      res,
      ctx,
      MANAGE,
      'reddit.opportunity.create',
      {},
      raw,
      201,
      (tx, step, b) => this.opportunities.create(tx, productOf(ctx), step, b),
    );
  }

  @Get(`${R}/opportunities/:id`)
  @PubAllow(READ)
  getOpportunity(@PubRequest() ctx: PubRequestCtx, @Param('id') id: string) {
    return loadOpportunityView(this.tenant(ctx), productOf(ctx).id, id);
  }

  /** Все редакции выдержки — при любом статусе (UI-аудит S2-2). */
  @Get(`${R}/opportunities/:id/excerpts`)
  @PubAllow(READ)
  listOpportunityExcerpts(
    @PubRequest() ctx: PubRequestCtx,
    @Param('id') id: string,
  ) {
    return opportunityExcerpts(this.tenant(ctx), productOf(ctx).id, id);
  }

  @Patch(`${R}/opportunities/:id`)
  @PubAllow(MANAGE)
  patchOpportunity(
    @PubRequest() ctx: PubRequestCtx,
    @Param('id') id: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.run(
      res,
      ctx,
      MANAGE,
      'reddit.opportunity.update',
      { id },
      raw,
      200,
      (tx, step, b) =>
        this.opportunities.patch(tx, productOf(ctx), id, step, b),
    );
  }

  @Post(`${R}/opportunities/:id/score`)
  @PubAllow(MANAGE)
  scoreOpportunity(
    @PubRequest() ctx: PubRequestCtx,
    @Param('id') id: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.run(
      res,
      ctx,
      MANAGE,
      'reddit.opportunity.score',
      { id },
      raw,
      200,
      (tx, step, b) =>
        this.opportunities.score(tx, productOf(ctx), id, step, b),
    );
  }

  @Post(`${R}/opportunities/:id/qualify`)
  @PubAllow(MANAGE)
  qualifyOpportunity(
    @PubRequest() ctx: PubRequestCtx,
    @Param('id') id: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.transition(ctx, id, raw, res, 'qualified');
  }

  @Post(`${R}/opportunities/:id/skip`)
  @PubAllow(MANAGE)
  skipOpportunity(
    @PubRequest() ctx: PubRequestCtx,
    @Param('id') id: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.transition(ctx, id, raw, res, 'skipped');
  }

  @Post(`${R}/opportunities/:id/archive`)
  @PubAllow(MANAGE)
  archiveOpportunity(
    @PubRequest() ctx: PubRequestCtx,
    @Param('id') id: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.transition(ctx, id, raw, res, 'archived');
  }

  private transition(
    ctx: PubRequestCtx,
    id: string,
    raw: unknown,
    res: Response,
    to: 'qualified' | 'skipped' | 'archived',
  ) {
    return this.run(
      res,
      ctx,
      MANAGE,
      `reddit.opportunity.${to}`,
      { id },
      raw,
      200,
      (tx, step, b) =>
        this.opportunities.transition(tx, productOf(ctx), id, to, step, b),
    );
  }

  // ── Ключевые запросы ───────────────────────────────────────────────────

  @Get(`${R}/keywords`)
  @PubAllow(READ)
  async listKeywords(
    @PubRequest() ctx: PubRequestCtx,
    @Query() q: Q,
    @Res() res: Response,
  ): Promise<void> {
    const { csv, limit, p } = this.paging(q, LIST_STATUSES.keywords);
    const rows = await listKeywords(this.tenant(ctx), productOf(ctx).id, p);
    await this.respond(res, ctx, 'keywords', csv, rows, limit);
  }

  @Post(`${R}/keywords`)
  @PubAllow(MANAGE)
  createKeyword(
    @PubRequest() ctx: PubRequestCtx,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.run(
      res,
      ctx,
      MANAGE,
      'reddit.keyword.create',
      {},
      raw,
      201,
      (tx, step, b) =>
        this.projects.createKeyword(tx, productOf(ctx), b, step.actor),
    );
  }

  @Patch(`${R}/keywords/:id`)
  @PubAllow(MANAGE)
  patchKeyword(
    @PubRequest() ctx: PubRequestCtx,
    @Param('id') id: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.run(
      res,
      ctx,
      MANAGE,
      'reddit.keyword.update',
      { id },
      raw,
      200,
      (tx, _step, b) => this.projects.patchKeyword(tx, productOf(ctx), id, b),
    );
  }

  // ── M2: брифы (§M2.1–M2.2) ─────────────────────────────────────────────

  @Get(`${R}/briefs`)
  @PubAllow(READ)
  async listBriefs(
    @PubRequest() ctx: PubRequestCtx,
    @Query() q: Q,
    @Res() res: Response,
  ): Promise<void> {
    const csv = formatOf(q.format) === 'csv';
    const limit = limitOf(q.limit, csv);
    const p = briefListParams(q, csv ? limit : limit + 1);
    const rows = await listBriefs(
      this.tenant(ctx) as never,
      productOf(ctx).id,
      p,
      new Date(),
    );
    await this.respond(res, ctx, 'briefs', csv, rows, limit, briefCsvRow);
  }

  @Post(`${R}/briefs`)
  @PubAllow(MANAGE)
  createBrief(
    @PubRequest() ctx: PubRequestCtx,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.run(
      res,
      ctx,
      MANAGE,
      'reddit.brief.create',
      {},
      raw,
      201,
      (tx, step, b) => this.briefs.create(tx, productOf(ctx), step, b),
    );
  }

  @Get(`${R}/briefs/:id`)
  @PubAllow(READ)
  getBrief(@PubRequest() ctx: PubRequestCtx, @Param('id') id: string) {
    return loadBriefView(this.tenant(ctx) as never, productOf(ctx).id, id);
  }

  @Patch(`${R}/briefs/:id`)
  @PubAllow(MANAGE)
  patchBrief(
    @PubRequest() ctx: PubRequestCtx,
    @Param('id') id: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.run(
      res,
      ctx,
      MANAGE,
      'reddit.brief.update',
      { id },
      raw,
      200,
      (tx, step, b) => this.briefs.patch(tx, productOf(ctx), id, step, b),
    );
  }

  @Post(`${R}/briefs/:id/ready`)
  @PubAllow(MANAGE)
  briefReady(
    @PubRequest() ctx: PubRequestCtx,
    @Param('id') id: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.run(
      res,
      ctx,
      MANAGE,
      'reddit.brief.ready',
      { id },
      raw,
      200,
      (tx, step, b) => this.briefs.ready(tx, productOf(ctx), id, step, b),
    );
  }

  @Post(`${R}/briefs/:id/archive`)
  @PubAllow(MANAGE)
  archiveBrief(
    @PubRequest() ctx: PubRequestCtx,
    @Param('id') id: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.run(
      res,
      ctx,
      MANAGE,
      'reddit.brief.archive',
      { id },
      raw,
      200,
      (tx, step, b) => this.briefs.archive(tx, productOf(ctx), id, step, b),
    );
  }

  /**
   * Генерация `pub.reddit.draft` (§M2.3): флаг, бриф, гейт правил, затем
   * шлюз P-B2 (идемпотентность по `opKey` — у шлюза, как у AI P0).
   */
  @Post(`${R}/briefs/:id/generate`)
  @PubAllow('ai.generate')
  generateDraft(
    @PubRequest() ctx: PubRequestCtx,
    @Param('id') id: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.generator.generate(
      productOf(ctx),
      ctx.m.memberId,
      id,
      bodyOf(raw),
      res,
    );
  }

  // ── M2: материалы, проверка, копирование, отчёт (§M2.4–M2.6) ──────────

  @Get(`${R}/briefs/:id/contents`)
  @PubAllow(READ)
  async listBriefContents(
    @PubRequest() ctx: PubRequestCtx,
    @Param('id') id: string,
  ) {
    const db = this.tenant(ctx) as never;
    const p = productOf(ctx);
    const brief = await loadBriefView(db, p.id, id);
    const items = [];
    for (const cid of brief.contentIds)
      items.push(await loadMaterialView(db, p.id, cid));
    return { items };
  }

  @Post(`${R}/briefs/:id/contents`)
  @PubAllow(MANAGE)
  createContent(
    @PubRequest() ctx: PubRequestCtx,
    @Param('id') id: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const p = productOf(ctx);
    return this.run(
      res,
      ctx,
      MANAGE,
      'reddit.content.create',
      { id },
      raw,
      201,
      async (tx, step, b) => {
        const out = await this.materials.createMaterial(
          tx,
          p,
          id,
          b,
          step.actor,
        );
        return {
          body: await loadMaterialView(tx, p.id, out.body.id, step.now),
          audit: out.audit,
        };
      },
    );
  }

  @Get(`${R}/contents/:cid`)
  @PubAllow(READ)
  getContent(@PubRequest() ctx: PubRequestCtx, @Param('cid') cid: string) {
    return loadMaterialView(this.tenant(ctx) as never, productOf(ctx).id, cid);
  }

  @Post(`${R}/contents/:cid/check`)
  @PubAllow('qa.technical')
  checkContent(
    @PubRequest() ctx: PubRequestCtx,
    @Param('cid') cid: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.run(
      res,
      ctx,
      'qa.technical',
      'reddit.content.check',
      { cid },
      raw,
      201,
      (tx, step) =>
        this.materials.recheck(tx, productOf(ctx), cid, step.actor, step.now),
    );
  }

  @Post(`${R}/contents/:cid/copy`)
  @PubAllow('reddit.handoff')
  copyContent(
    @PubRequest() ctx: PubRequestCtx,
    @Param('cid') cid: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.run(
      res,
      ctx,
      'reddit.handoff',
      'reddit.content.copy',
      { cid },
      raw,
      200,
      (tx, step, b) =>
        this.materials.copy(
          tx,
          productOf(ctx),
          cid,
          actorsOf(ctx.access),
          step.now,
          b,
        ),
    );
  }

  @Post(`${R}/contents/:cid/report-publication`)
  @PubAllow('reddit.handoff')
  reportPublication(
    @PubRequest() ctx: PubRequestCtx,
    @Param('cid') cid: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.run(
      res,
      ctx,
      'reddit.handoff',
      'reddit.content.report',
      { cid },
      raw,
      201,
      (tx, step, b, opKey) =>
        this.handoff.report(tx, productOf(ctx), cid, step, b, opKey),
    );
  }

  @Get(`${R}/publications`)
  @PubAllow(READ)
  async listPublications(
    @PubRequest() ctx: PubRequestCtx,
    @Query() q: Q,
    @Res() res: Response,
  ): Promise<void> {
    const csv = formatOf(q.format) === 'csv';
    const limit = limitOf(q.limit, csv);
    const p = publicationListParams(q, csv ? limit : limit + 1);
    const rows = await listPublications(
      this.tenant(ctx) as never,
      productOf(ctx).id,
      p,
    );
    await this.respond(
      res,
      ctx,
      'publications',
      csv,
      rows,
      limit,
      publicationCsvRow,
    );
  }
}
