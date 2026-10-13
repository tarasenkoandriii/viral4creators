/**
 * AI Publisher, P-C — маршруты каналов, календаря F09, публикаций и
 * площадок F10 (проектный документ §11.3; контракт
 * `contracts/distribution-api.ts`). Мутации — `runOperation` (`opKey` в
 * теле, `expectedRevision` для голов); чтения `opKey` не принимают.
 *
 * AI-план распространения и AI-сравнение площадок в P0 выключены (ДТ-2,
 * Р-PUB-31): маршруты отвечают 409 `PUB_AI_DISABLED` — это решение, а не
 * заглушка; календарь и сравнение карточек — вручную.
 */
import { Body, Get, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { SitesDb } from '../../../prisma/sites-db.service';
import { P0_ENABLED_GENERATORS } from '../contracts/ai';
import { PubError, validationError } from '../core/errors';
import type { DistributionActionView } from '../contracts/distribution-api';
import { PubOperations, type OperationRef } from '../core/operation';
import type { PubTx } from '../core/ports';
import {
  PubAllow,
  PubCabinetController,
  PubRequest,
  type PubRequestCtx,
} from '../core/pub-role.guard';
import { ChannelsService } from './channels.service';
import { versionTarget } from './content-read';
import { DistributionService } from './distribution.service';
import {
  dateQ,
  formatOf,
  limitOf,
  mutate,
  productOf,
  respondList,
  sendEnvelope,
  strQ,
} from './http';
import { PublicationsService } from './publications.service';
import { VenuesService } from './venues.service';

/** Выключенный в P0 генератор (§12.2) — 409, ручной путь обязателен. */
function aiDisabled(generator: string): never {
  if ((P0_ENABLED_GENERATORS as readonly string[]).includes(generator)) {
    throw new Error(
      `${generator}: генератор включён — маршрут должен идти через AiGateway`,
    );
  }
  throw new PubError('PUB_AI_DISABLED', { generator, manual: true });
}

@PubCabinetController()
export class PublisherDistributionController {
  constructor(
    private readonly db: SitesDb,
    private readonly ops: PubOperations,
    private readonly channels: ChannelsService,
    private readonly distribution: DistributionService,
    private readonly publications: PublicationsService,
    private readonly venues: VenuesService,
  ) {}

  private tenant(ctx: PubRequestCtx) {
    return this.db.forAccount(ctx.m.accountId);
  }

  /**
   * Ответ действия несёт снимок имени владельца (`ownerDisplayName`): в
   * ключ идемпотентности — только id, повтор пересобирает ответ из базы
   * (Р-PUB-A1-13, S2-3).
   */
  private actionNoStore(ctx: PubRequestCtx) {
    return {
      refOf: (body: DistributionActionView) => ({ actionId: body.id }),
      rebuild: async (tx: PubTx, ref: OperationRef | null) => {
        if (!ref || typeof ref.actionId !== 'string') {
          throw new PubError('PUB_NOT_FOUND');
        }
        return this.distribution.view(tx, productOf(ctx).id, ref.actionId);
      },
    };
  }

  // ── Каналы ─────────────────────────────────────────────────────────────

  @Get('products/:pid/channels')
  @PubAllow('product.read')
  async listChannels(@PubRequest() ctx: PubRequestCtx) {
    return {
      items: await this.channels.list(this.tenant(ctx), productOf(ctx).id),
    };
  }

  @Post('products/:pid/channels')
  @PubAllow('channel.manage')
  createChannel(
    @PubRequest() ctx: PubRequestCtx,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return mutate(res, {
      ops: this.ops,
      ctx,
      action: 'channel.manage',
      scope: 'channel.create',
      pathParams: { pid: productOf(ctx).id },
      raw,
      status: 201,
      fn: (tx, step, b) => this.channels.create(tx, productOf(ctx), step, b),
    });
  }

  @Patch('products/:pid/channels/:id')
  @PubAllow('channel.manage')
  patchChannel(
    @PubRequest() ctx: PubRequestCtx,
    @Param('id') id: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return mutate(res, {
      ops: this.ops,
      ctx,
      action: 'channel.manage',
      scope: 'channel.update',
      pathParams: { pid: productOf(ctx).id, id },
      raw,
      status: 200,
      fn: (tx, _step, b) => this.channels.patch(tx, productOf(ctx), id, b),
    });
  }

  // ── Календарь F09 ──────────────────────────────────────────────────────

  @Post('products/:pid/distribution/plan')
  @PubAllow('distribution.manage')
  aiPlan(): never {
    return aiDisabled('pub.distribution.plan');
  }

  @Get('products/:pid/distribution/actions')
  @PubAllow('product.read')
  async listActions(
    @PubRequest() ctx: PubRequestCtx,
    @Query() q: Record<string, unknown>,
    @Res() res: Response,
  ) {
    const format = formatOf(q.format);
    const limit = limitOf(q.limit, format === 'csv');
    const rows = await this.distribution.list(
      this.tenant(ctx),
      productOf(ctx).id,
      {
        status: strQ(q.status),
        owner: strQ(q.owner),
        channelId: strQ(q.channelId),
        from: dateQ(q.from, 'from'),
        to: dateQ(q.to, 'to'),
        before: strQ(q.before),
        limit: limit + 1,
      },
    );
    await respondList(
      res,
      this.ops,
      ctx,
      'distribution-actions',
      format,
      rows,
      limit,
      [
        'id',
        'plannedAt',
        'channelId',
        'versionId',
        'contentId',
        'format',
        'goal',
        'ownerMemberId',
        'ownerDisplayName',
        'status',
        'blockReason',
        'measurableUrl',
        'publicationId',
        'doneUrl',
      ],
    );
  }

  @Post('products/:pid/distribution/actions')
  @PubAllow('distribution.manage')
  createAction(
    @PubRequest() ctx: PubRequestCtx,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return mutate(res, {
      ops: this.ops,
      ctx,
      action: 'distribution.manage',
      scope: 'distribution.action.create',
      pathParams: { pid: productOf(ctx).id },
      raw,
      status: 201,
      fn: (tx, step, b) =>
        this.distribution.create(tx, productOf(ctx), step, b),
      noStore: this.actionNoStore(ctx),
    });
  }

  @Post('products/:pid/distribution/actions/:id/transition')
  @PubAllow('distribution.manage')
  actionTransition(
    @PubRequest() ctx: PubRequestCtx,
    @Param('id') id: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return mutate(res, {
      ops: this.ops,
      ctx,
      action: 'distribution.manage',
      scope: 'distribution.action.transition',
      pathParams: { pid: productOf(ctx).id, id },
      raw,
      status: 200,
      fn: (tx, _step, b) =>
        this.distribution.transition(tx, productOf(ctx), ctx.access, id, b),
      noStore: this.actionNoStore(ctx),
    });
  }

  /** Измеряемая ссылка для канала/закупки/версии (`core/utm.ts`). */
  @Get('products/:pid/utm')
  @PubAllow('distribution.manage')
  async utm(
    @PubRequest() ctx: PubRequestCtx,
    @Query() q: Record<string, unknown>,
  ) {
    const tx = this.tenant(ctx);
    const p = productOf(ctx);
    const placementId = strQ(q.placementId);
    if (placementId) {
      const pl = await tx.pubPlacement.findFirst({
        where: { id: placementId, productId: p.id },
        select: { issuedUrl: true },
      });
      if (!pl?.issuedUrl) throw new PubError('PUB_NOT_FOUND');
      const u = new URL(pl.issuedUrl);
      return {
        url: pl.issuedUrl,
        utm: {
          source: u.searchParams.get('utm_source') ?? '',
          medium: u.searchParams.get('utm_medium') ?? '',
          campaign: u.searchParams.get('utm_campaign') ?? '',
          content: u.searchParams.get('utm_content') ?? undefined,
        },
      };
    }
    const channelId = strQ(q.channelId);
    const versionId = strQ(q.versionId);
    if (!channelId || !versionId) {
      throw validationError([
        { field: channelId ? 'versionId' : 'channelId', code: 'required' },
      ]);
    }
    const channel = await tx.pubChannel.findFirst({
      where: { id: channelId, productId: p.id },
    });
    if (!channel) throw new PubError('PUB_NOT_FOUND');
    const target = await versionTarget(tx, p.id, versionId);
    if (!target) throw new PubError('PUB_NOT_FOUND');
    if (!target.siteUrl) {
      throw validationError([{ field: 'versionId', code: 'site_url_unknown' }]);
    }
    const url = await this.distribution.measurableUrl(
      tx,
      p.id,
      channel,
      target.siteUrl,
    );
    const u = new URL(url);
    return {
      url,
      utm: {
        source: u.searchParams.get('utm_source') ?? '',
        medium: u.searchParams.get('utm_medium') ?? '',
        campaign: u.searchParams.get('utm_campaign') ?? '',
      },
    };
  }

  // ── Публикации ─────────────────────────────────────────────────────────

  @Get('products/:pid/publications')
  @PubAllow('product.read')
  async listPublications(
    @PubRequest() ctx: PubRequestCtx,
    @Query() q: Record<string, unknown>,
    @Res() res: Response,
  ) {
    const format = formatOf(q.format);
    const limit = limitOf(q.limit, format === 'csv');
    const rows = await this.publications.list(
      this.tenant(ctx),
      productOf(ctx).id,
      {
        versionId: strQ(q.versionId),
        channelId: strQ(q.channelId),
        status: strQ(q.status),
        before: strQ(q.before),
        limit: limit + 1,
      },
    );
    await respondList(res, this.ops, ctx, 'publications', format, rows, limit, [
      'id',
      'versionId',
      'channelId',
      'stage',
      'finalUrl',
      'publishedAt',
      'status',
      'verifyStatus',
      'lastVerifiedAt',
    ]);
  }

  @Post('products/:pid/publications')
  @PubAllow('publication.manage')
  createPublication(
    @PubRequest() ctx: PubRequestCtx,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return mutate(res, {
      ops: this.ops,
      ctx,
      action: 'publication.manage',
      scope: 'publication.create',
      pathParams: { pid: productOf(ctx).id },
      raw,
      status: 201,
      fn: (tx, step, b, opKey) =>
        this.publications.create(tx, productOf(ctx), step, b, opKey),
    });
  }

  @Post('products/:pid/publications/:id/verify')
  @PubAllow('publication.manage')
  verifyPublication(
    @PubRequest() ctx: PubRequestCtx,
    @Param('id') id: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return mutate(res, {
      ops: this.ops,
      ctx,
      action: 'publication.manage',
      scope: 'publication.verify',
      pathParams: { pid: productOf(ctx).id, id },
      raw,
      status: 200,
      fn: (tx, step, b) =>
        this.publications.verify(tx, productOf(ctx), step, id, b),
    });
  }

  @Post('products/:pid/publications/:id/transition')
  @PubAllow('publication.manage')
  publicationTransition(
    @PubRequest() ctx: PubRequestCtx,
    @Param('id') id: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return mutate(res, {
      ops: this.ops,
      ctx,
      action: 'publication.manage',
      scope: 'publication.transition',
      pathParams: { pid: productOf(ctx).id, id },
      raw,
      status: 200,
      fn: (tx, step, b) =>
        this.publications.transition(
          tx,
          productOf(ctx),
          ctx.access,
          step,
          id,
          b,
        ),
    });
  }

  // ── Площадки F10 ───────────────────────────────────────────────────────

  @Get('products/:pid/venues')
  @PubAllow('product.read')
  async listVenues(
    @PubRequest() ctx: PubRequestCtx,
    @Query() q: Record<string, unknown>,
    @Res() res: Response,
  ) {
    const format = formatOf(q.format);
    const limit = limitOf(q.limit, format === 'csv');
    const rows = await this.venues.list(this.tenant(ctx), productOf(ctx).id, {
      status: strQ(q.status),
      before: strQ(q.before),
      limit: limit + 1,
    });
    if (format === 'json') {
      sendEnvelope(res, {
        items: rows.slice(0, limit),
        nextBefore: rows.length > limit ? rows[limit - 1].id : null,
      });
      return;
    }
    await respondList(
      res,
      this.ops,
      ctx,
      'venues',
      format,
      rows.map((v) => ({
        ...v,
        scoreSum: v.score.sum,
        scoreMax: v.score.max,
        missing: v.missingForVerified.join(' '),
      })),
      limit,
      [
        'id',
        'title',
        'url',
        'status',
        'scoreSum',
        'scoreMax',
        'completeness',
        'linkMarking',
        'missing',
      ],
    );
  }

  @Get('products/:pid/venues/:id')
  @PubAllow('product.read')
  async getVenue(@PubRequest() ctx: PubRequestCtx, @Param('id') id: string) {
    return this.venues.view(this.tenant(ctx), productOf(ctx).id, id);
  }

  @Post('products/:pid/venues')
  @PubAllow('venue.manage')
  createVenue(
    @PubRequest() ctx: PubRequestCtx,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return mutate(res, {
      ops: this.ops,
      ctx,
      action: 'venue.manage',
      scope: 'venue.create',
      pathParams: { pid: productOf(ctx).id },
      raw,
      status: 201,
      fn: (tx, step, b) => this.venues.create(tx, productOf(ctx), step, b),
    });
  }

  @Post('products/:pid/venues/compare')
  @PubAllow('venue.manage')
  aiCompare(): never {
    return aiDisabled('pub.venues.compare');
  }

  @Patch('products/:pid/venues/:id')
  @PubAllow('venue.manage')
  patchVenue(
    @PubRequest() ctx: PubRequestCtx,
    @Param('id') id: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return mutate(res, {
      ops: this.ops,
      ctx,
      action: 'venue.manage',
      scope: 'venue.update',
      pathParams: { pid: productOf(ctx).id, id },
      raw,
      status: 200,
      fn: (tx, step, b) => this.venues.patch(tx, productOf(ctx), step, id, b),
    });
  }

  @Post('products/:pid/venues/:id/transition')
  @PubAllow('venue.manage')
  venueTransition(
    @PubRequest() ctx: PubRequestCtx,
    @Param('id') id: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return mutate(res, {
      ops: this.ops,
      ctx,
      action: 'venue.manage',
      scope: 'venue.transition',
      pathParams: { pid: productOf(ctx).id, id },
      raw,
      status: 200,
      fn: (tx, _step, b) =>
        this.venues.transition(tx, productOf(ctx), ctx.access, id, b),
    });
  }
}
