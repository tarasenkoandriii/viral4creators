/**
 * AI Publisher, P-C — календарь распространения F09 (проектный документ
 * §6.4 `pub_distribution_actions`, §7.5; AT-F09-01/02). План строится
 * вручную: AI-план `pub.distribution.plan` в P0 выключен (ДТ-2).
 *
 *  - у действия есть версия, канал, формат, цель, срок, владелец и
 *    измеряемая ссылка: с UTM для внешних каналов, без UTM для `site`;
 *  - канал недоступен / запрещает рекламу, материал `criticalStale` —
 *    действие `blocked` с причиной (а не тихий перенос в другой канал);
 *  - `done` — только с записью публикации той же версии в том же канале и
 *    реальным URL; запись задачи ≠ факт публикации (F09).
 */
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { ProductCtx } from '../contracts/common';
import type {
  DistributionActionView,
  DistributionBlockReason,
} from '../contracts/distribution-api';
import {
  DISTRIBUTION_BLOCK_REASONS,
  type DistributionStatus,
} from '../contracts/states';
import {
  PubContribution,
  type MemberReassignContributor,
} from '../core/contributions';
import { PubError, validationError } from '../core/errors';
import { PILOT_CAMPAIGN_CODE } from '../core/product.service';
import type { ProductRef, PubTx } from '../core/ports';
import { assertRevision, parseExpectedRevision } from '../core/revision';
import type { PubAccess } from '../core/roles';
import { DISTRIBUTION_MACHINE, assertTransition } from '../core/state-machines';
import { buildMeasurableUrl, UtmError } from '../core/utm';
import { memberDisplayName } from './approvals-purchase.service';
import { versionTarget } from './content-read';
import { Fields, type Body } from './input';
import { actorsOf, type OpResult, type Step } from './placements.service';

type ActionRow = Prisma.PubDistributionActionGetPayload<object>;

export function actionView(
  a: ActionRow,
  contentId: string,
  doneUrl: string | null,
): DistributionActionView {
  return {
    id: a.id,
    versionId: a.versionId,
    contentId,
    channelId: a.channelId,
    format: a.format,
    goal: a.goal,
    plannedAt: a.plannedAt.toISOString(),
    ownerMemberId: a.ownerMemberId,
    ownerDisplayName: a.ownerDisplayName,
    status: a.status as DistributionActionView['status'],
    blockReason: a.blockReason as DistributionBlockReason | null,
    measurableUrl: a.measurableUrl,
    publicationId: a.publicationId,
    doneUrl,
    revision: a.revision,
  };
}

/** Причина блокировки канала/материала или null (AT-F09-02). */
export function blockReasonOf(
  channel: { status: string; adsAllowed: boolean | null },
  criticalStale: boolean,
): DistributionBlockReason | null {
  if (channel.status !== 'available') return 'channel_unavailable';
  if (channel.adsAllowed === false) return 'ads_not_allowed';
  if (criticalStale) return 'content_stale';
  return null;
}

@Injectable()
export class DistributionService {
  async row(tx: PubTx, productId: string, id: string): Promise<ActionRow> {
    const a = await tx.pubDistributionAction.findFirst({
      where: { id, productId },
    });
    if (!a) throw new PubError('PUB_NOT_FOUND');
    return a;
  }

  async view(tx: PubTx, productId: string, id: string) {
    const a = await this.row(tx, productId, id);
    return (await this.views(tx, [a]))[0];
  }

  async views(tx: PubTx, rows: ActionRow[]): Promise<DistributionActionView[]> {
    const versions = await tx.pubContentVersion.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.versionId))] } },
      select: { id: true, contentId: true },
    });
    const pubIds = rows
      .map((r) => r.publicationId)
      .filter((x): x is string => !!x);
    const pubs = pubIds.length
      ? await tx.pubPublication.findMany({
          where: { id: { in: pubIds } },
          select: { id: true, finalUrl: true },
        })
      : [];
    const contentOf = new Map(versions.map((v) => [v.id, v.contentId]));
    const urlOf = new Map(pubs.map((p) => [p.id, p.finalUrl]));
    return rows.map((r) =>
      actionView(
        r,
        contentOf.get(r.versionId) ?? '',
        r.status === 'done' && r.publicationId
          ? (urlOf.get(r.publicationId) ?? null)
          : null,
      ),
    );
  }

  async list(
    tx: PubTx,
    productId: string,
    q: {
      status?: string;
      owner?: string;
      channelId?: string;
      from?: Date;
      to?: Date;
      before?: string;
      limit: number;
    },
  ): Promise<DistributionActionView[]> {
    const rows = await tx.pubDistributionAction.findMany({
      where: {
        productId,
        ...(q.status ? { status: q.status } : {}),
        ...(q.owner ? { ownerMemberId: q.owner } : {}),
        ...(q.channelId ? { channelId: q.channelId } : {}),
        ...(q.from || q.to
          ? {
              plannedAt: {
                ...(q.from ? { gte: q.from } : {}),
                ...(q.to ? { lt: q.to } : {}),
              },
            }
          : {}),
        ...(q.before ? { id: { lt: q.before } } : {}),
      },
      orderBy: { id: 'desc' },
      take: q.limit,
    });
    return this.views(tx, rows);
  }

  /** Измеряемая ссылка канала (`core/utm.ts`): UTM только у внешних каналов. */
  async measurableUrl(
    tx: PubTx,
    productId: string,
    channel: { kind: string; utmSource: string; utmMedium: string },
    dest: string,
  ): Promise<string> {
    const campaign = await tx.pubCampaign.findFirst({
      where: { productId, code: PILOT_CAMPAIGN_CODE },
      select: { code: true },
    });
    try {
      return channel.kind === 'site'
        ? buildMeasurableUrl(dest, {})
        : buildMeasurableUrl(dest, {
            source: channel.utmSource,
            medium: channel.utmMedium,
            campaign: campaign?.code ?? PILOT_CAMPAIGN_CODE,
          });
    } catch (e) {
      if (e instanceof UtmError) {
        throw validationError([{ field: `utm.${e.field}`, code: e.code }]);
      }
      throw e;
    }
  }

  async create(
    tx: PubTx,
    product: ProductCtx,
    step: Step,
    b: Body,
  ): Promise<OpResult<DistributionActionView>> {
    const f = new Fields();
    const versionId = f.id(b, 'versionId');
    const channelId = f.id(b, 'channelId');
    const format = f.str(b, 'format', 100);
    const goal = f.str(b, 'goal', 2000);
    const plannedAt = f.date(b, 'plannedAt');
    const ownerMemberId = f.id(b, 'ownerMemberId');
    const ownerDisplayName = f.str(b, 'ownerDisplayName', 200, {
      optional: true,
    });
    const targetUrl = f.https(b, 'targetUrl', { optional: true });
    f.done();
    if (
      !versionId ||
      !channelId ||
      !format ||
      !goal ||
      !plannedAt ||
      !ownerMemberId
    ) {
      throw validationError([{ field: '$', code: 'required' }]);
    }
    const target = await versionTarget(tx, product.id, versionId);
    if (!target) throw new PubError('PUB_NOT_FOUND', { field: 'versionId' });
    const channel = await tx.pubChannel.findFirst({
      where: { id: channelId, productId: product.id },
    });
    if (!channel) throw new PubError('PUB_NOT_FOUND', { field: 'channelId' });
    const member = await tx.siteAccountMember.findFirst({
      where: { id: ownerMemberId },
      select: { id: true },
    });
    if (!member) {
      throw validationError([{ field: 'ownerMemberId', code: 'not_member' }]);
    }
    const dest = targetUrl ?? target.siteUrl;
    if (!dest)
      throw validationError([{ field: 'targetUrl', code: 'required' }]);
    const measurableUrl = await this.measurableUrl(
      tx,
      product.id,
      channel,
      dest,
    );
    const reason = blockReasonOf(channel, target.criticalStale);
    const row = await tx.pubDistributionAction.create({
      data: {
        accountId: product.accountId,
        productId: product.id,
        versionId,
        channelId,
        format,
        goal,
        plannedAt,
        ownerMemberId,
        ownerDisplayName:
          ownerDisplayName ??
          (await memberDisplayName(tx, product.id, ownerMemberId)),
        status: reason ? 'blocked' : 'planned',
        blockReason: reason,
        measurableUrl,
        createdBy: step.actor,
      },
    });
    return {
      body: (await this.views(tx, [row]))[0],
      audit: [
        {
          objectType: 'distribution_action',
          objectId: row.id,
          action: 'create',
          toStatus: row.status,
          meta: { versionId, channelId, blockReason: reason },
        },
      ],
    };
  }

  async transition(
    tx: PubTx,
    product: ProductCtx,
    access: PubAccess,
    id: string,
    b: Body,
  ): Promise<OpResult<DistributionActionView>> {
    const expected = parseExpectedRevision(b.expectedRevision);
    const f = new Fields();
    const to = f.oneOf(b, 'to', [
      'blocked',
      'done',
      'cancelled',
      'planned',
    ] as const);
    f.done();
    const a = await this.row(tx, product.id, id);
    assertTransition(
      DISTRIBUTION_MACHINE,
      a.status as DistributionStatus,
      to!,
      {
        actors: actorsOf(access),
      },
    );
    assertRevision(a.revision, expected);
    const channel = await tx.pubChannel.findFirst({
      where: { id: a.channelId },
    });
    const target = await versionTarget(tx, product.id, a.versionId);
    const data: Prisma.PubDistributionActionUncheckedUpdateManyInput = {
      status: to!,
    };
    if (to === 'blocked') {
      const reason = f.oneOf(b, 'reason', DISTRIBUTION_BLOCK_REASONS);
      f.done();
      data.blockReason = reason;
    } else if (to === 'planned') {
      // Снятие блокировки — только если причина устранена.
      const still = channel
        ? blockReasonOf(channel, target?.criticalStale ?? false)
        : null;
      if (still) {
        throw new PubError('PUB_TRANSITION_INVALID', {
          machine: 'distribution_action',
          from: a.status,
          to,
          allowed: [],
          reason: still,
        });
      }
      data.blockReason = null;
    } else if (to === 'done') {
      if (target?.criticalStale) throw new PubError('PUB_CONTENT_STALE');
      const still = channel
        ? blockReasonOf(channel, false)
        : 'channel_unavailable';
      if (still) {
        throw new PubError('PUB_TRANSITION_INVALID', {
          machine: 'distribution_action',
          from: a.status,
          to,
          allowed: ['blocked', 'cancelled'],
          reason: still,
        });
      }
      const publicationId = f.id(b, 'publicationId');
      f.done();
      const pub = await tx.pubPublication.findFirst({
        where: { id: publicationId!, productId: product.id },
        select: { id: true, versionId: true, channelId: true, status: true },
      });
      if (
        !pub ||
        pub.versionId !== a.versionId ||
        pub.channelId !== a.channelId ||
        !['published', 'replaced'].includes(pub.status)
      ) {
        throw validationError([
          { field: 'publicationId', code: 'publication' },
        ]);
      }
      data.publicationId = pub.id;
    }
    const r = await tx.pubDistributionAction.updateMany({
      where: { id, revision: expected, status: a.status },
      data: { ...data, revision: { increment: 1 } },
    });
    if (r.count !== 1) throw new PubError('PUB_CONFLICT');
    return {
      body: await this.view(tx, product.id, id),
      audit: [
        {
          objectType: 'distribution_action',
          objectId: id,
          action: 'transition',
          fromStatus: a.status,
          toStatus: to,
          meta: {
            ...(data.blockReason
              ? { blockReason: data.blockReason as string }
              : {}),
            ...(data.publicationId
              ? { publicationId: data.publicationId as string }
              : {}),
          },
        },
      ],
    };
  }
}

/**
 * Удалённый из кабинета участник (§4.1, `members-reconcile`): открытые
 * действия распространения и открытые претензии по закупкам (владелец
 * претензии, AT-CORE-16, S3-7) переходят владельцу кабинета.
 */
@Injectable()
@PubContribution('member-reassign')
export class DistributionActionsReassign implements MemberReassignContributor {
  readonly key = 'distribution-actions' as const;

  async reassign(
    tx: PubTx,
    product: ProductRef,
    fromMemberId: string,
    toMemberId: string,
  ): Promise<number> {
    const r = await tx.pubDistributionAction.updateMany({
      where: {
        productId: product.id,
        ownerMemberId: fromMemberId,
        status: { in: ['planned', 'blocked'] },
      },
      data: {
        ownerMemberId: toMemberId,
        ownerDisplayName: await memberDisplayName(tx, product.id, toMemberId),
        revision: { increment: 1 },
      },
    });
    const claims = await tx.pubPlacement.updateMany({
      where: {
        productId: product.id,
        claimOwnerMemberId: fromMemberId,
        claimStatus: 'open',
      },
      data: { claimOwnerMemberId: toMemberId, revision: { increment: 1 } },
    });
    return r.count + claims.count;
  }
}
