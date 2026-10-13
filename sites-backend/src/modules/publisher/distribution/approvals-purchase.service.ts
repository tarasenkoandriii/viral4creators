/**
 * AI Publisher, P-C — согласования `purchase` и `reserve_release`
 * (проектный документ §6.3 `pub_approvals`, §7.2, §7.5; аудит P3-28: этот
 * сервис пишет ТОЛЬКО эти два типа — `publish_version` у P-B1,
 * `ai_extra_generation` у P-B2) и задание `approvals-expire-purchase`.
 *
 * Согласование закупки фиксирует hash продвигаемой версии, снимок цены
 * (`priceSnapshotHash`), максимум и валюту; срок — не позже
 * min(`offerExpiresAt`, решение + 72 ч). Истёкшее не разрешает резерв даже
 * при прежней цене: сервис проверяет `expiresAt > now` сам, крон лишь
 * переводит статус (AT-F12-02).
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { SitesDb } from '../../../prisma/sites-db.service';
import { PubContribution } from '../core/contributions';
import { canonicalJson, sha256Hex } from '../core/content-hash';
import { PubError } from '../core/errors';
import type {
  CronJob,
  CronResult,
  ProductRef,
  PubCronContext,
  PubTx,
} from '../core/ports';
import { PubPorts } from '../core/ports';

export const PURCHASE_APPROVAL_MAX_HOURS = 72;
const HOUR_MS = 3_600_000;

export type PurchaseApprovalType = 'purchase' | 'reserve_release';

/** Снимок цены закупки (§6.3: `{venueId, totalPriceMinor, currency, fx, terms, offerExpiresAt}`). */
export function priceSnapshotHash(p: {
  venueId: string;
  totalPriceMinor: bigint;
  currency: string;
  origCurrency: string | null;
  origAmountMinor: bigint | null;
  fxRate: { toString(): string } | null;
  fxSource: string | null;
  fxAt: Date | null;
  terms: string | null;
  offerExpiresAt: Date | null;
}): string {
  return sha256Hex(
    canonicalJson({
      venueId: p.venueId,
      totalPriceMinor: p.totalPriceMinor.toString(),
      currency: p.currency,
      fx: p.origCurrency
        ? {
            currency: p.origCurrency,
            amountMinor: p.origAmountMinor?.toString() ?? null,
            rate: p.fxRate ? normalizeRate(p.fxRate.toString()) : null,
            source: p.fxSource,
            at: p.fxAt?.toISOString() ?? null,
          }
        : null,
      terms: p.terms,
      offerExpiresAt: p.offerExpiresAt?.toISOString() ?? null,
    }),
  );
}

/** «41.50000000» и «41.5» — один курс. */
function normalizeRate(v: string): string {
  if (!v.includes('.')) return v;
  return v.replace(/0+$/, '').replace(/\.$/, '');
}

/** Срок согласования закупки: min(оферта, решение + 72 ч, запрошенный). */
export function purchaseApprovalExpiry(
  decidedAt: Date,
  offerExpiresAt: Date | null,
  requested?: Date | null,
): Date {
  let t = decidedAt.getTime() + PURCHASE_APPROVAL_MAX_HOURS * HOUR_MS;
  if (offerExpiresAt) t = Math.min(t, offerExpiresAt.getTime());
  if (requested) t = Math.min(t, requested.getTime());
  return new Date(t);
}

/** Снимок отображаемого имени участника (без контактов, §4.1). */
export async function memberDisplayName(
  tx: PubTx,
  productId: string,
  memberId: string,
): Promise<string> {
  const g = await tx.pubRoleGrant.findFirst({
    where: { productId, memberId },
    orderBy: { grantedAt: 'desc' },
    select: { memberDisplayName: true },
  });
  return g?.memberDisplayName ?? `Учасник …${memberId.slice(-6)}`;
}

@Injectable()
export class PurchaseApprovalsService {
  async createPurchase(
    tx: PubTx,
    product: ProductRef,
    a: {
      placementId: string;
      maxAmountMinor: bigint;
      currency: string;
      versionHash: string;
      priceSnapshotHash: string;
      decidedAt: Date;
      expiresAt: Date;
      approverMemberId: string;
      selfReview: boolean;
      reason: string | null;
      actor: string;
    },
  ): Promise<string> {
    if (a.expiresAt.getTime() <= a.decidedAt.getTime()) {
      // Оферта уже истекла: согласовывать нечего.
      throw new PubError('PUB_APPROVAL_EXPIRED', { reason: 'offer_expired' });
    }
    const row = await tx.pubApproval.create({
      data: {
        accountId: product.accountId,
        productId: product.id,
        type: 'purchase',
        objectType: 'placement',
        objectId: a.placementId,
        versionHash: a.versionHash,
        priceSnapshotHash: a.priceSnapshotHash,
        maxAmountMinor: a.maxAmountMinor,
        currency: a.currency,
        approverMemberId: a.approverMemberId,
        approverDisplayName: await memberDisplayName(
          tx,
          product.id,
          a.approverMemberId,
        ),
        decidedAt: a.decidedAt,
        expiresAt: a.expiresAt,
        selfReview: a.selfReview,
        reason: a.reason,
        createdBy: a.actor,
      },
      select: { id: true },
    });
    return row.id;
  }

  async createReserveRelease(
    tx: PubTx,
    product: ProductRef,
    a: {
      limitId: string;
      amountMinor: bigint;
      currency: string;
      approverMemberId: string;
      reason: string;
      actor: string;
      now: Date;
    },
  ): Promise<string> {
    const row = await tx.pubApproval.create({
      data: {
        accountId: product.accountId,
        productId: product.id,
        type: 'reserve_release',
        objectType: 'budget_limit',
        objectId: a.limitId,
        maxAmountMinor: a.amountMinor,
        currency: a.currency,
        approverMemberId: a.approverMemberId,
        approverDisplayName: await memberDisplayName(
          tx,
          product.id,
          a.approverMemberId,
        ),
        decidedAt: a.now,
        selfReview: false,
        reason: a.reason,
        createdBy: a.actor,
      },
      select: { id: true },
    });
    return row.id;
  }

  /**
   * Израсходовать действующее согласование закупки, когда обязательство
   * уже выровнено по его цене без положительной корректировки (повторное
   * согласование после резерва при снижении или той же сумме, S0-1).
   */
  async consume(tx: PubTx, approvalId: string): Promise<boolean> {
    const r = await tx.pubApproval.updateMany({
      where: { id: approvalId, status: 'active', type: 'purchase' },
      data: { status: 'consumed' },
    });
    return r.count === 1;
  }

  /** Снять действующее согласование закупки (отклонение, повторное согласование). */
  async close(
    tx: PubTx,
    approvalId: string,
    to: 'revoked' | 'superseded',
    reason: string | null,
  ): Promise<boolean> {
    const r = await tx.pubApproval.updateMany({
      where: {
        id: approvalId,
        status: 'active',
        type: { in: ['purchase', 'reserve_release'] },
      },
      data: { status: to, ...(reason ? { reason } : {}) },
    });
    return r.count === 1;
  }
}

/**
 * Задание `approvals-expire-purchase` (tick, §15.1, Р-PUB-A1-9): `active`
 * согласования закупок с `expiresAt ≤ now` → `expired` + аудит. Продукты
 * `kind=restored|eval` не обрабатываются.
 */
@Injectable()
@PubContribution('cron-job')
export class ApprovalsExpirePurchaseJob implements CronJob {
  readonly key = 'approvals-expire-purchase';
  readonly schedule = 'tick' as const;

  constructor(
    private readonly db: SitesDb,
    private readonly ports: PubPorts,
  ) {}

  async run(ctx: PubCronContext): Promise<CronResult> {
    const system = this.db.system(
      'крон publisher approvals-expire-purchase: истёкшие согласования закупок всех кабинетов',
    );
    const scope = ctx.scope
      ? Prisma.sql`AND p."siteId" = ANY(${ctx.scope.siteIds}::text[])`
      : Prisma.empty;
    const due = await system.$queryRaw<
      Array<{ id: string; accountId: string; productId: string }>
    >`
      SELECT a."id", a."accountId", a."productId"
        FROM "sites"."pub_approvals" a
        JOIN "sites"."pub_products" p ON p."id" = a."productId"
       WHERE a."type" = 'purchase' AND a."status" = 'active' AND a."expiresAt" <= ${ctx.now}
         AND p."kind" IN ('working', 'test') AND p."status" = 'active' ${scope}
       ORDER BY a."expiresAt"
       LIMIT 500`;
    let processed = 0;
    for (const a of due) {
      if (Date.now() > ctx.deadline.getTime()) break;
      await this.db.forAccount(a.accountId).$transaction(async (tx) => {
        const r = await tx.pubApproval.updateMany({
          where: {
            id: a.id,
            type: 'purchase',
            status: 'active',
            expiresAt: { lte: ctx.now },
          },
          data: { status: 'expired' },
        });
        if (r.count !== 1) return;
        processed++;
        await this.ports.audit().write(tx, {
          accountId: a.accountId,
          productId: a.productId,
          actor: 'system:approvals-expire-purchase',
          objectType: 'approval',
          objectId: a.id,
          action: 'transition',
          fromStatus: 'active',
          toStatus: 'expired',
          occurredAt: ctx.now,
        });
      });
    }
    return { processed, details: { expired: processed } };
  }
}
