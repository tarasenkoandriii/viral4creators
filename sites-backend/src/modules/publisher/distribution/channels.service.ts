/**
 * AI Publisher, P-C — каналы распространения (проектный документ §6.4
 * `pub_channels`; F09). Канал `site` (собственный сайт) создаётся вместе с
 * продуктом (вклад `product-init: site-channel`), второй не заводится;
 * прочие — `own` (два собственных, ТЗ §17), `community`, `paid_venue`.
 * `adsAllowed=false` или `unavailable` делают действия канала `blocked`
 * (AT-F09-02).
 */
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { ProductCtx } from '../contracts/common';
import type { ChannelView } from '../contracts/distribution-api';
import {
  PubContribution,
  type ProductInitContributor,
  type ProductInitContext,
} from '../core/contributions';
import { PubError, validationError } from '../core/errors';
import type { PubTx } from '../core/ports';
import { assertRevision, parseExpectedRevision } from '../core/revision';
import { isValidUtmValue } from '../core/utm';
import { BudgetService } from './budget.service';
import { Fields, type Body } from './input';
import type { OpResult, Step } from './placements.service';

type ChannelRow = Prisma.PubChannelGetPayload<object>;

export const SITE_CHANNEL_CODE = 'site';

export function channelView(c: ChannelRow): ChannelView {
  return {
    id: c.id,
    code: c.code,
    title: c.name,
    kind: c.kind as ChannelView['kind'],
    utmSource: c.utmSource,
    utmMedium: c.utmMedium,
    adsAllowed: c.adsAllowed,
    rulesNote: c.rulesNote,
    status: c.status as ChannelView['status'],
    revision: c.revision,
  };
}

function utmField(f: Fields, b: Body, field: string): string | null {
  const v = f.str(b, field, 100, { pii: false });
  if (v !== null && !isValidUtmValue(v)) {
    f.add(field, 'format');
    return null;
  }
  return v;
}

@Injectable()
export class ChannelsService {
  async row(tx: PubTx, productId: string, id: string): Promise<ChannelRow> {
    const c = await tx.pubChannel.findFirst({ where: { id, productId } });
    if (!c) throw new PubError('PUB_NOT_FOUND');
    return c;
  }

  async list(tx: PubTx, productId: string): Promise<ChannelView[]> {
    const rows = await tx.pubChannel.findMany({
      where: { productId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map(channelView);
  }

  async create(
    tx: PubTx,
    product: ProductCtx,
    step: Step,
    b: Body,
  ): Promise<OpResult<ChannelView>> {
    const f = new Fields();
    f.only(b, [
      'opKey',
      'code',
      'title',
      'kind',
      'utmSource',
      'utmMedium',
      'adsAllowed',
      'rulesNote',
    ]);
    const code = f.str(b, 'code', 64, { pii: false });
    if (code !== null && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(code)) {
      f.add('code', 'format');
    }
    const title = f.str(b, 'title', 200);
    const kind = f.oneOf(b, 'kind', [
      'own',
      'community',
      'paid_venue',
    ] as const);
    const utmSource = utmField(f, b, 'utmSource');
    const utmMedium = utmField(f, b, 'utmMedium');
    const adsAllowed = f.bool(b, 'adsAllowed');
    const rulesNote = f.str(b, 'rulesNote', 2000, { optional: true });
    f.done();
    if (!code || !title || !kind || !utmSource || !utmMedium) {
      throw validationError([{ field: '$', code: 'required' }]);
    }
    const row = await tx.pubChannel.create({
      data: {
        accountId: product.accountId,
        productId: product.id,
        code,
        name: title,
        kind,
        utmSource,
        utmMedium,
        adsAllowed: adsAllowed ?? null,
        rulesNote,
        createdBy: step.actor,
      },
    });
    return {
      body: channelView(row),
      audit: [
        {
          objectType: 'channel',
          objectId: row.id,
          action: 'create',
          toStatus: row.status,
          meta: { code, kind },
        },
      ],
    };
  }

  async patch(
    tx: PubTx,
    product: ProductCtx,
    id: string,
    b: Body,
  ): Promise<OpResult<ChannelView>> {
    const expected = parseExpectedRevision(b.expectedRevision);
    const c = await this.row(tx, product.id, id);
    assertRevision(c.revision, expected);
    const f = new Fields();
    f.only(b, [
      'opKey',
      'expectedRevision',
      'title',
      'utmSource',
      'utmMedium',
      'adsAllowed',
      'rulesNote',
      'status',
    ]);
    const data: Prisma.PubChannelUncheckedUpdateManyInput = {};
    if (b.title !== undefined) data.name = f.str(b, 'title', 200) ?? c.name;
    if (b.utmSource !== undefined)
      data.utmSource = utmField(f, b, 'utmSource') ?? c.utmSource;
    if (b.utmMedium !== undefined)
      data.utmMedium = utmField(f, b, 'utmMedium') ?? c.utmMedium;
    if (b.adsAllowed !== undefined)
      data.adsAllowed = f.bool(b, 'adsAllowed') ?? null;
    if (b.rulesNote !== undefined) {
      data.rulesNote = f.str(b, 'rulesNote', 2000, { optional: true });
    }
    if (b.status !== undefined) {
      data.status =
        f.oneOf(b, 'status', ['available', 'unavailable'] as const) ??
        undefined;
    }
    f.done();
    const r = await tx.pubChannel.updateMany({
      where: { id, revision: expected },
      data: { ...data, revision: { increment: 1 } },
    });
    if (r.count !== 1) throw new PubError('PUB_CONFLICT');
    const after = await this.row(tx, product.id, id);
    return {
      body: channelView(after),
      audit: [
        {
          objectType: 'channel',
          objectId: id,
          action: 'update',
          fromStatus: c.status,
          toStatus: after.status,
          meta: { adsAllowed: after.adsAllowed },
        },
      ],
    };
  }
}

/** Вклад создания продукта: канал `site` (§6.4, §11.3). */
@Injectable()
@PubContribution('product-init')
export class SiteChannelInit implements ProductInitContributor {
  readonly key = 'site-channel' as const;

  async init(
    tx: PubTx,
    product: ProductCtx,
    ctx: ProductInitContext,
  ): Promise<void> {
    await tx.pubChannel.create({
      data: {
        accountId: product.accountId,
        productId: product.id,
        code: SITE_CHANNEL_CODE,
        name: 'Сайт',
        kind: 'site',
        utmSource: 'site',
        utmMedium: 'owned',
        adsAllowed: null,
        createdBy: ctx.actor,
      },
    });
  }
}

/**
 * Вклад создания продукта: строка лимита бюджета «в черновике» из
 * засеянных допущений (§11.3). Гейты `spend`/`purchases` закрыты, пока
 * бюджетные параметры не утверждены (после решения порт пересоберёт лимит).
 */
@Injectable()
@PubContribution('product-init')
export class BudgetLimitInit implements ProductInitContributor {
  readonly key = 'budget-limit' as const;

  constructor(private readonly budget: BudgetService) {}

  async init(
    tx: PubTx,
    product: ProductCtx,
    ctx: ProductInitContext,
  ): Promise<void> {
    await this.budget.build(tx, product, ctx.actor);
  }
}
