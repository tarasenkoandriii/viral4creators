/**
 * AI Publisher, P-B1 — маршруты кабинета: источники, вопросы F01, группы,
 * факты бренда и оффер F02, «что увидит AI» (проектный документ §11.3;
 * контракт `contracts/content-api.ts`).
 */
import { Body, Get, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { SitesDb } from '../../../prisma/sites-db.service';
import {
  DEFAULT_PINNED_HTTP_DEPS,
  type PinnedHttpDeps,
} from '../../site-crawl/net/pinned-fetch';
import { PublicPageFetcher } from '../../site-crawl/page-fetcher';
import type {
  BrandFactView,
  OfferVersionView,
  QuestionGroupView,
  QuestionView,
  SourceView,
} from '../contracts/content-api';
import {
  BRAND_FACT_STATUSES,
  QUESTION_STATUSES,
  SOURCE_KINDS,
  SOURCE_USAGES,
  SOURCE_VISIBILITIES,
} from '../contracts/states';
import { PubError, validationError } from '../core/errors';
import { PubOperations, type OperationRef } from '../core/operation';
import type { PubTx } from '../core/ports';
import {
  PubAllow,
  PubCabinetController,
  PubRequest,
  type PubRequestCtx,
} from '../core/pub-role.guard';
import { BrandService } from './brand.service';
import {
  ContentControllerBase,
  actorsOf,
  productOf,
} from './content-base.controller';
import { selectContext } from './context-selection';
import {
  clampLimit,
  csvOf,
  formatOf,
  pageOf,
  sendCsv,
  sendEnvelope,
} from './http';
import { bodyOf, Issues, limitOf, strQ } from './input';
import { QuestionsService } from './questions.service';
import { RevocationService } from './revocation.service';
import { fetchForImport } from './source-import';
import { SourcesService } from './sources.service';
import {
  factView,
  loadGroup,
  loadOffer,
  loadSource,
  questionView,
  sourceView,
} from './views';

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

/**
 * Р-PUB-Z2-19 (z-pii-scan): ответы мутаций источника несут `fragment` —
 * материал владельца, где бывают контакты; в ключе идемпотентности — только
 * hash и `ref`, повтор пересобирает ответ из базы.
 */
function SOURCE_NO_STORE(pid: string) {
  return {
    noStore: {
      refOf: (v: unknown) => ({ sourceId: (v as { id: string }).id }),
      rebuild: async (tx: PubTx, ref: OperationRef | null) =>
        loadSource(tx, pid, String(ref?.sourceId)),
    },
  };
}

@PubCabinetController('products/:pid')
export class ContentSourcesController extends ContentControllerBase {
  constructor(
    db: SitesDb,
    ops: PubOperations,
    private readonly sources: SourcesService,
    private readonly revocation: RevocationService,
    private readonly questions: QuestionsService,
    private readonly brand: BrandService,
    private readonly fetcher: PublicPageFetcher,
  ) {
    super(db, ops);
  }

  /**
   * Резолвер для уточнения причины отказа импорта (аудит P-B1 S3-1); сама
   * загрузка — только `fetcher`. Тесты подменяют вместе с `fetcher`.
   */
  private importNet: Pick<PinnedHttpDeps, 'lookupAll'> =
    DEFAULT_PINNED_HTTP_DEPS;

  // ── Источники ──────────────────────────────────────────────────────────

  @Get('sources')
  @PubAllow('product.read')
  async listSources(
    @PubRequest() ctx: PubRequestCtx,
    @Query() q: Record<string, unknown>,
    @Res() res: Response,
  ) {
    const p = productOf(ctx);
    const csv = formatOf(q.format) === 'csv';
    const usage = enumQ(q.usage, SOURCE_USAGES, 'usage');
    const kind = enumQ(q.kind, SOURCE_KINDS, 'kind');
    const visibility = enumQ(q.visibility, SOURCE_VISIBILITIES, 'visibility');
    const limit = clampLimit(limitOf(q.limit), csv);
    const before = strQ(q.before);
    const db = this.tenant(ctx);
    const rows = await db.pubSource.findMany({
      where: {
        productId: p.id,
        // Доказательства Reddit (P-R) — только в маршрутах раздела Reddit
        // (`reddit.read` + флаг), не в общем списке (аудит P-R S2-1).
        origin: 'content',
        // Общая выгрузка — без отозванных источников (AT-CORE-21).
        // И без прежних редакций — только последняя (аудит P-B1 S1-1/S2-4).
        ...(csv
          ? {
              usage: usage && usage !== 'revoked' ? usage : { not: 'revoked' },
              sourceSupersedesOf: { none: {} },
            }
          : usage
            ? { usage }
            : {}),
        ...(kind ? { kind } : {}),
        ...(visibility ? { visibility } : {}),
        ...(before ? { id: { lt: before } } : {}),
      },
      orderBy: { id: 'desc' },
      take: limit + 1,
    });
    const locked = new Set(
      (
        await db.pubVersionSource.findMany({
          where: {
            productId: p.id,
            sourceId: { in: rows.map((r) => r.id) },
            version: { frozenAt: { not: null } },
          },
          select: { sourceId: true },
        })
      ).map((x) => x.sourceId),
    );
    const page = pageOf(
      rows.map((r) => sourceView(r, locked.has(r.id))),
      limit,
    );
    if (!csv) return sendEnvelope(res, page);
    await this.ops.recordRead(ctx.m, ctx.access, p, 'product.read', {
      objectType: 'product',
      objectId: p.id,
      action: 'export',
      meta: { list: 'sources', count: page.items.length },
    });
    // Без текста фрагментов (приватный текст) и без закрытых ссылок.
    sendCsv(
      res,
      'sources',
      csvOf<SourceView>(page.items, [
        ['id', (x) => x.id],
        ['kind', (x) => x.kind],
        ['title', (x) => x.title],
        ['url', (x) => (x.visibility === 'public' ? x.url : null)],
        ['usage', (x) => x.usage],
        ['visibility', (x) => x.visibility],
        ['freshness', (x) => x.freshness],
        ['checkedAt', (x) => x.checkedAt],
        ['importedVia', (x) => x.importedVia],
        ['createdAt', (x) => x.createdAt],
      ]),
    );
  }

  @Get('sources/:id')
  @PubAllow('product.read')
  async getSource(@PubRequest() ctx: PubRequestCtx, @Param('id') id: string) {
    const db = this.tenant(ctx);
    const pid = productOf(ctx).id;
    // Доказательство Reddit (P-R) — как несуществующий источник (S2-1).
    const hidden = await db.pubSource.findFirst({
      where: { id, productId: pid, origin: 'reddit' },
      select: { id: true },
    });
    if (hidden) throw new PubError('PUB_NOT_FOUND');
    return loadSource(db, pid, id);
  }

  @Post('sources')
  @PubAllow('source.manage')
  async createSource(
    @PubRequest() ctx: PubRequestCtx,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const b = bodyOf(raw);
    const p = productOf(ctx);
    return this.run(
      ctx,
      res,
      'source.manage',
      'source.create',
      { pid: p.id },
      b,
      (tx, s) => this.sources.create(tx, p, b, s.actor),
      { status: 201, ...SOURCE_NO_STORE(p.id) },
    );
  }

  @Post('sources/import-url')
  @PubAllow('source.manage')
  async importUrl(
    @PubRequest() ctx: PubRequestCtx,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const b = bodyOf(raw);
    const p = productOf(ctx);
    const is = new Issues();
    const url = is.str(b, 'url', { required: true, max: 2048 });
    const visibility = is.oneOf(b, 'visibility', SOURCE_VISIBILITIES, true);
    is.throwIfAny();
    // Сеть — ВНЕ транзакции операции (§8.1); загрузка — только общим входом site-crawl.
    const page = await fetchForImport(
      this.fetcher,
      this.db.system('publisher import: opt-out и кэш robots'),
      url!,
      this.importNet,
    );
    return this.run(
      ctx,
      res,
      'source.manage',
      'source.import',
      { pid: p.id },
      b,
      (tx, s) => this.sources.storeImport(tx, p, page, visibility!, s.actor),
      { status: 201, ...SOURCE_NO_STORE(p.id) },
    );
  }

  @Patch('sources/:id')
  @PubAllow('source.manage')
  async patchSource(
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
      'source.manage',
      'source.update',
      { pid: p.id, id },
      b,
      (tx, s) => this.sources.patch(tx, p, id, b, s.actor, s.now),
      SOURCE_NO_STORE(p.id),
    );
  }

  @Post('sources/:id/revoke')
  @PubAllow('source.manage')
  async revokeSource(
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
      'source.manage',
      'source.revoke',
      { pid: p.id, id },
      b,
      (tx, s) => this.revocation.revoke(tx, p, id, b, s.actor, s.now),
      {
        noStore: {
          refOf: (v) => ({
            sourceId: v.source.id,
            revocationId: v.revocationId,
            tasksOpened: v.tasksOpened,
          }),
          rebuild: async (tx, ref) => ({
            source: await loadSource(tx, p.id, String(ref?.sourceId)),
            revocationId: String(ref?.revocationId),
            tasksOpened: Number(ref?.tasksOpened ?? 0),
          }),
        },
      },
    );
  }

  // ── Вопросы F01 ────────────────────────────────────────────────────────

  @Get('questions')
  @PubAllow('product.read')
  async listQuestions(
    @PubRequest() ctx: PubRequestCtx,
    @Query() q: Record<string, unknown>,
    @Res() res: Response,
  ) {
    const p = productOf(ctx);
    const csv = formatOf(q.format) === 'csv';
    const status = enumQ(q.status, QUESTION_STATUSES, 'status');
    const groupId = strQ(q.groupId);
    const limit = clampLimit(limitOf(q.limit), csv);
    const before = strQ(q.before);
    const rows = await this.tenant(ctx).pubQuestion.findMany({
      where: {
        productId: p.id,
        ...(status ? { status } : {}),
        ...(groupId ? { groupId } : {}),
        ...(before ? { id: { lt: before } } : {}),
      },
      include: { questionSourceQuestionOf: { orderBy: { createdAt: 'asc' } } },
      orderBy: { id: 'desc' },
      take: limit + 1,
    });
    const page = pageOf(rows.map(questionView), limit);
    if (!csv) return sendEnvelope(res, page);
    await this.ops.recordRead(ctx.m, ctx.access, p, 'product.read', {
      objectType: 'product',
      objectId: p.id,
      action: 'export',
      meta: { list: 'questions', count: page.items.length },
    });
    sendCsv(
      res,
      'questions',
      csvOf<QuestionView>(page.items, [
        ['id', (x) => x.id],
        ['text', (x) => x.text],
        ['stage', (x) => x.stage],
        ['groupId', (x) => x.groupId],
        ['status', (x) => x.status],
        ['selectedRank', (x) => x.selectedRank],
        ['frequency', (x) => x.frequencyLabel],
        ['offer_fit', (x) => x.scores.offer_fit?.score ?? null],
        ['confirmed_task', (x) => x.scores.confirmed_task?.score ?? null],
        ['own_answer', (x) => x.scores.own_answer?.score ?? null],
        ['cost', (x) => x.scores.cost?.score ?? null],
        ['sources', (x) => x.sources.map((s) => s.sourceId).join(' ')],
      ]),
    );
  }

  @Post('questions')
  @PubAllow('question.manage')
  async createQuestion(
    @PubRequest() ctx: PubRequestCtx,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const b = bodyOf(raw);
    const p = productOf(ctx);
    return this.run(
      ctx,
      res,
      'question.manage',
      'question.create',
      { pid: p.id },
      b,
      (tx, s) => this.questions.create(tx, p, b, s.actor),
      { status: 201 },
    );
  }

  @Patch('questions/:id')
  @PubAllow('question.manage')
  async patchQuestion(
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
      'question.manage',
      'question.update',
      { pid: p.id, id },
      b,
      (tx, s) => this.questions.patch(tx, p, id, b, s.actor),
    );
  }

  @Get('question-groups')
  @PubAllow('product.read')
  async listGroups(
    @PubRequest() ctx: PubRequestCtx,
    @Query() q: Record<string, unknown>,
  ) {
    const p = productOf(ctx);
    const limit = clampLimit(limitOf(q.limit), false);
    const before = strQ(q.before);
    const db = this.tenant(ctx);
    const rows = await db.pubQuestionGroup.findMany({
      where: { productId: p.id, ...(before ? { id: { lt: before } } : {}) },
      orderBy: { id: 'desc' },
      take: limit + 1,
      select: { id: true },
    });
    const views: QuestionGroupView[] = [];
    for (const r of rows) views.push(await loadGroup(db, p.id, r.id));
    return pageOf(views, limit);
  }

  @Post('question-groups')
  @PubAllow('question.manage')
  async createGroup(
    @PubRequest() ctx: PubRequestCtx,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const b = bodyOf(raw);
    const p = productOf(ctx);
    return this.run<QuestionGroupView>(
      ctx,
      res,
      'question.manage',
      'question_group.create',
      { pid: p.id },
      b,
      (tx, s) =>
        this.questions.createGroup(tx, p, b, s.actor, actorsOf(ctx.access)),
      {
        status: 201,
        // Ответ несёт `task` (ключ из списка ПД ключа идемпотентности).
        noStore: {
          refOf: (v) => ({ groupId: v.id }),
          rebuild: (tx, ref) => loadGroup(tx, p.id, String(ref?.groupId)),
        },
      },
    );
  }

  @Patch('question-groups/:id')
  @PubAllow('question.manage')
  async patchGroup(
    @PubRequest() ctx: PubRequestCtx,
    @Param('id') id: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const b = bodyOf(raw);
    const p = productOf(ctx);
    return this.run<QuestionGroupView>(
      ctx,
      res,
      'question.manage',
      'question_group.update',
      { pid: p.id, id },
      b,
      (tx) => this.questions.patchGroup(tx, p, id, b),
      {
        noStore: {
          refOf: (v) => ({ groupId: v.id }),
          rebuild: (tx) => loadGroup(tx, p.id, id),
        },
      },
    );
  }

  // ── Факты бренда и оффер F02 ───────────────────────────────────────────

  @Get('brand-facts')
  @PubAllow('product.read')
  async listFacts(
    @PubRequest() ctx: PubRequestCtx,
    @Query() q: Record<string, unknown>,
    @Res() res: Response,
  ) {
    const p = productOf(ctx);
    const csv = formatOf(q.format) === 'csv';
    const status = enumQ(q.status, BRAND_FACT_STATUSES, 'status');
    const factKey = strQ(q.factKey);
    const limit = clampLimit(limitOf(q.limit), csv);
    const before = strQ(q.before);
    const rows = await this.tenant(ctx).pubBrandFact.findMany({
      where: {
        productId: p.id,
        ...(status ? { status } : {}),
        ...(factKey ? { factKey } : {}),
        ...(before ? { id: { lt: before } } : {}),
      },
      orderBy: { id: 'desc' },
      take: limit + 1,
    });
    const page = pageOf(rows.map(factView), limit);
    if (!csv) return sendEnvelope(res, page);
    await this.ops.recordRead(ctx.m, ctx.access, p, 'product.read', {
      objectType: 'product',
      objectId: p.id,
      action: 'export',
      meta: { list: 'brand-facts', count: page.items.length },
    });
    sendCsv(
      res,
      'brand-facts',
      csvOf<BrandFactView>(page.items, [
        ['id', (x) => x.id],
        ['factKey', (x) => x.factKey],
        ['kind', (x) => x.kind],
        ['version', (x) => x.version],
        ['status', (x) => x.status],
        ['value', (x) => x.value],
        ['scope', (x) => x.scope],
        ['approvedAt', (x) => x.approvedAt],
      ]),
    );
  }

  @Post('brand-facts')
  @PubAllow('brand.draft')
  async createFact(
    @PubRequest() ctx: PubRequestCtx,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const b = bodyOf(raw);
    const p = productOf(ctx);
    return this.run(
      ctx,
      res,
      'brand.draft',
      'brand_fact.create',
      { pid: p.id },
      b,
      (tx, s) => this.brand.createFact(tx, p, b, s.actor),
      { status: 201 },
    );
  }

  @Post('brand-facts/:id/activate')
  @PubAllow('brand.activate')
  async activateFact(
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
      'brand.activate',
      'brand_fact.activate',
      { pid: p.id, id },
      b,
      (tx, s) => this.brand.activateFact(tx, p, id, b, s.actor, s.now),
    );
  }

  @Post('brand-facts/:id/resolve')
  @PubAllow('brand.activate')
  async resolveFact(
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
      'brand.activate',
      'brand_fact.resolve',
      { pid: p.id, id },
      b,
      (tx, s) => this.brand.resolveFact(tx, p, id, b, s.actor, s.now),
    );
  }

  @Post('brand-facts/:id/retire')
  @PubAllow('brand.activate')
  async retireFact(
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
      'brand.activate',
      'brand_fact.retire',
      { pid: p.id, id },
      b,
      (tx, s) => this.brand.retireFact(tx, p, id, b, s.actor, s.now),
    );
  }

  @Get('offers')
  @PubAllow('product.read')
  async listOffers(
    @PubRequest() ctx: PubRequestCtx,
    @Query() q: Record<string, unknown>,
  ) {
    const p = productOf(ctx);
    const limit = clampLimit(limitOf(q.limit), false);
    const before = strQ(q.before);
    const db = this.tenant(ctx);
    const rows = await db.pubOfferVersion.findMany({
      where: { productId: p.id, ...(before ? { id: { lt: before } } : {}) },
      orderBy: { id: 'desc' },
      take: limit + 1,
      select: { id: true },
    });
    const views: OfferVersionView[] = [];
    for (const r of rows) views.push(await loadOffer(db, p.id, r.id));
    return pageOf(views, limit);
  }

  @Post('offers')
  @PubAllow('brand.activate')
  async createOffer(
    @PubRequest() ctx: PubRequestCtx,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const b = bodyOf(raw);
    const p = productOf(ctx);
    return this.run(
      ctx,
      res,
      'brand.activate',
      'offer.create',
      { pid: p.id },
      b,
      (tx, s) => this.brand.createOffer(tx, p, b, s.actor),
      { status: 201 },
    );
  }

  @Post('offers/:id/activate')
  @PubAllow('brand.activate')
  async activateOffer(
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
      'brand.activate',
      'offer.activate',
      { pid: p.id, id },
      b,
      (tx, s) =>
        this.brand.activateOffer(
          tx,
          p,
          id,
          b,
          s.actor,
          actorsOf(ctx.access),
          s.now,
        ),
    );
  }

  @Get('context-preview')
  @PubAllow('source.manage')
  async contextPreview(
    @PubRequest() ctx: PubRequestCtx,
    @Query() q: Record<string, unknown>,
  ) {
    const p = productOf(ctx);
    const purpose = strQ(q.purpose) ?? 'helper';
    if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(purpose)) {
      throw validationError([{ field: 'purpose', code: 'format' }]);
    }
    const audience =
      enumQ(q.audience, ['internal', 'public'] as const, 'audience') ??
      'internal';
    const ids = strQ(q.sourceIds);
    const sourceIds = ids ? ids.split(',').filter(Boolean) : undefined;
    if (
      sourceIds &&
      (sourceIds.length > 200 ||
        sourceIds.some((x) => !/^[A-Za-z0-9_-]{1,100}$/.test(x)))
    ) {
      throw validationError([{ field: 'sourceIds', code: 'type' }]);
    }
    return selectContext(this.tenant(ctx), p.id, {
      purpose,
      audience,
      sourceIds,
    });
  }
}
