/**
 * AI Publisher, P-B1 — паспорт утверждений F04 (проектный документ §6.3
 * `pub_claims`, `pub_claim_sources`; AT-F04-01/02, AT-F06-02).
 *
 *  - claims вводит редактор (извлечение AI в P0 выключено, ДТ-2);
 *    собственный результат ссылается на эксперимент;
 *  - связь claim → источник фиксирует ЧЕЛОВЕК: `supports`
 *    (`yes|no|partial|unknown`), `checkedBy`, `checkedAt` (проверка после
 *    последнего изменения источника — иначе подтверждение устарело);
 *  - `supported` любого claim — только с поддерживающим (`yes`)
 *    разрешённым источником, проверенным после его изменения; у
 *    критического — ещё и `verifiedBy` человека (триггер). Наличие URL само
 *    по себе не даёт `supported`;
 *  - правка `statement/type/risk` claim, связанного с замороженной
 *    версией, — НОВАЯ строка с `supersedesId` (подтверждения не
 *    переносятся: старое подтверждение не заменяет проверку) и каскад
 *    `claim_changed` по версиям и адаптациям (критический — `criticalStale`).
 */
import { Injectable } from '@nestjs/common';
import type { PatchClaimResponse, ClaimView } from '../contracts/content-api';
import { CLAIM_RISKS, CLAIM_SUPPORTS, CLAIM_TYPES } from '../contracts/states';
import { PubError, validationError } from '../core/errors';
import { PubPorts, type ProductRef, type PubTx } from '../core/ports';
import type { Actor } from '../core/state-machines';
import { casUpdate, parseExpectedRevision } from '../core/revision';
import { isSelfReview, type PubAccess } from '../core/roles';
import { ContentCascades, decidedVersionIds } from './cascades';
import { has, Issues, type Body } from './input';
import { acceptAiCall, assertAiCall, assertSourceIds } from './refs';
import type { OpOut } from './sources.service';
import { loadClaim } from './views';

@Injectable()
export class ClaimsService {
  constructor(
    private readonly cascades: ContentCascades,
    private readonly ports: PubPorts,
  ) {}

  async create(
    tx: PubTx,
    product: ProductRef,
    b: Body,
    actor: string,
    actors: Actor[],
  ): Promise<OpOut<ClaimView>> {
    const is = new Issues();
    const statement = is.str(b, 'statement', { required: true, max: 1000 });
    const type = is.oneOf(b, 'type', CLAIM_TYPES, true);
    const risk = is.oneOf(b, 'risk', CLAIM_RISKS, true);
    const fromVersion = is.str(b, 'extractedFromVersionId', { max: 100 });
    const experimentId = is.str(b, 'experimentId', { max: 100 });
    const nextCheckAt = is.date(b, 'nextCheckAt');
    const aiRaw = is.str(b, 'aiCallId', { max: 100 });
    is.throwIfAny();
    if (fromVersion) {
      const v = await tx.pubContentVersion.findFirst({
        where: { id: fromVersion, productId: product.id },
        select: { id: true },
      });
      if (!v)
        throw validationError([
          { field: 'extractedFromVersionId', code: 'not_found' },
        ]);
    }
    if (experimentId) {
      const e = await tx.pubExperiment.findFirst({
        where: { id: experimentId, productId: product.id },
        select: { id: true },
      });
      if (!e)
        throw validationError([{ field: 'experimentId', code: 'not_found' }]);
    }
    const aiCallId = await assertAiCall(tx, product.id, aiRaw, [
      'pub.claims.extract',
      'pub.qa.review',
    ]);
    const row = await tx.pubClaim.create({
      data: {
        accountId: product.accountId,
        productId: product.id,
        statement: statement!,
        type: type!,
        risk: risk!,
        status: 'unverified',
        extractedFromVersionId: fromVersion ?? null,
        experimentId: experimentId ?? null,
        nextCheckAt: nextCheckAt ?? null,
        aiCallId,
        createdBy: actor,
      },
    });
    const accepted = await acceptAiCall(
      this.ports,
      tx,
      product,
      aiCallId,
      actors,
    );
    return {
      body: await loadClaim(tx, product.id, row.id),
      audit: [
        {
          objectType: 'claim',
          objectId: row.id,
          action: 'create',
          toStatus: 'unverified',
          meta: { type: row.type, risk: row.risk, aiCallId },
        },
        ...accepted,
      ],
    };
  }

  async patch(
    tx: PubTx,
    product: ProductRef,
    id: string,
    b: Body,
    actor: string,
    now: Date,
  ): Promise<OpOut<PatchClaimResponse>> {
    const expected = parseExpectedRevision(b.expectedRevision);
    const cur = await tx.pubClaim.findFirst({
      where: { id, productId: product.id },
    });
    if (!cur) throw new PubError('PUB_NOT_FOUND');
    const is = new Issues();
    const statement = has(b, 'statement')
      ? is.str(b, 'statement', { required: true, max: 1000 })
      : undefined;
    const type = has(b, 'type')
      ? is.oneOf(b, 'type', CLAIM_TYPES, true)
      : undefined;
    const risk = has(b, 'risk')
      ? is.oneOf(b, 'risk', CLAIM_RISKS, true)
      : undefined;
    const nextCheckAt = has(b, 'nextCheckAt')
      ? (is.date(b, 'nextCheckAt') ?? null)
      : undefined;
    is.throwIfAny();
    if (cur.revision !== expected)
      throw new PubError('PUB_CONFLICT', { currentRevision: cur.revision });
    const newer = await tx.pubClaim.findFirst({
      where: { supersedesId: id, productId: product.id },
      select: { id: true },
    });
    if (newer) {
      throw new PubError('PUB_CONFLICT', {
        reason: 'claim_superseded',
        claimId: newer.id,
      });
    }
    const next = {
      statement: statement ?? cur.statement,
      type: type ?? cur.type,
      risk: risk ?? cur.risk,
    };
    const changed =
      next.statement !== cur.statement ||
      next.type !== cur.type ||
      next.risk !== cur.risk;
    const frozenLinks = await tx.pubVersionClaim.count({
      where: {
        claimId: id,
        productId: product.id,
        version: { frozenAt: { not: null } },
      },
    });
    if (!changed || frozenLinks === 0) {
      await casUpdate(tx.pubClaim, id, expected, {
        ...next,
        ...(nextCheckAt !== undefined ? { nextCheckAt } : {}),
        // Изменённая фраза — прежнее подтверждение не действует.
        ...(changed && cur.status === 'supported'
          ? { status: 'needs_review' }
          : {}),
      });
      return {
        body: {
          claim: await loadClaim(tx, product.id, id),
          supersededId: null,
          cascade: null,
        },
        audit: [
          {
            objectType: 'claim',
            objectId: id,
            action: 'update',
            meta: { changed },
          },
        ],
      };
    }
    // Связан с замороженной версией: новая строка + каскад (F04, F06).
    const row = await tx.pubClaim.create({
      data: {
        accountId: product.accountId,
        productId: product.id,
        ...next,
        status: 'unverified',
        extractedFromVersionId: cur.extractedFromVersionId,
        experimentId: cur.experimentId,
        supersedesId: id,
        nextCheckAt: nextCheckAt !== undefined ? nextCheckAt : cur.nextCheckAt,
        createdBy: actor,
      },
    });
    const links = await tx.pubVersionClaim.findMany({
      where: { claimId: id, productId: product.id },
      select: { versionId: true },
    });
    const cascade = await this.cascades.run(tx, product, {
      reason: 'claim_changed',
      triggerRef: `claim:${row.id}`,
      versionIds: links.map((l) => l.versionId),
      critical: cur.risk === 'critical' || next.risk === 'critical',
      actor,
      now,
    });
    return {
      body: {
        claim: await loadClaim(tx, product.id, row.id),
        supersededId: id,
        cascade,
      },
      audit: [
        {
          objectType: 'claim',
          objectId: row.id,
          action: 'create',
          toStatus: 'unverified',
          meta: { supersedesId: id, tasksOpened: cascade.tasksOpened },
        },
      ],
    };
  }

  /** Человек фиксирует, подтверждает ли источник ИМЕННО эту фразу. */
  async linkSource(
    tx: PubTx,
    product: ProductRef,
    id: string,
    b: Body,
    actor: string,
    now: Date,
  ): Promise<OpOut<ClaimView>> {
    const is = new Issues();
    const sourceId = is.str(b, 'sourceId', { required: true, max: 100 });
    const supports = is.oneOf(b, 'supports', CLAIM_SUPPORTS, true);
    const note = is.str(b, 'note', { max: 2000, pii: true });
    is.throwIfAny();
    const c = await tx.pubClaim.findFirst({
      where: { id, productId: product.id },
    });
    if (!c) throw new PubError('PUB_NOT_FOUND');
    await assertSourceIds(tx, product.id, [sourceId!], 'sourceId');
    const weakened = c.status === 'supported' && supports !== 'yes';
    if (weakened) {
      // Ослабление доказательства подтверждённого claim — снова проверка.
      await tx.pubClaim.update({
        where: { id },
        data: { status: 'needs_review', revision: { increment: 1 } },
      });
    }
    await tx.pubClaimSource.upsert({
      where: { claimId_sourceId: { claimId: id, sourceId: sourceId! } },
      create: {
        accountId: product.accountId,
        productId: product.id,
        claimId: id,
        sourceId: sourceId!,
        supports: supports!,
        note: note ?? null,
        checkedBy: actor,
        checkedAt: now,
        createdBy: actor,
      },
      update: {
        supports: supports!,
        note: note ?? null,
        checkedBy: actor,
        checkedAt: now,
      },
    });
    const cascade = weakened
      ? await this.afterDecision(
          tx,
          product,
          c,
          `claim-source:${id}:${sourceId}:${now.getTime()}`,
          actor,
          now,
        )
      : null;
    return {
      body: await loadClaim(tx, product.id, id),
      audit: [
        {
          objectType: 'claim',
          objectId: id,
          action: 'update',
          meta: {
            sourceId: sourceId!,
            supports: supports!,
            tasksOpened: cascade?.tasksOpened ?? 0,
          },
        },
      ],
    };
  }

  /**
   * Отрицательное решение по claim ПОСЛЕ согласования (аудит P-B1 S0-1):
   * каскад `claim_changed` по согласованным/показанным версиям —
   * опубликованные → `correction_required` (+ `criticalStale` у критического),
   * согласования неопубликованных → `superseded`, задачи.
   */
  private async afterDecision(
    tx: PubTx,
    product: ProductRef,
    c: { id: string; risk: string },
    triggerRef: string,
    actor: string,
    now: Date,
  ) {
    const links = await tx.pubVersionClaim.findMany({
      where: {
        productId: product.id,
        claimId: c.id,
        version: { frozenAt: { not: null } },
      },
      select: { versionId: true },
    });
    const ids = await decidedVersionIds(
      tx,
      product.id,
      links.map((l) => l.versionId),
    );
    return this.cascades.run(tx, product, {
      reason: 'claim_changed',
      triggerRef,
      versionIds: ids,
      critical: c.risk === 'critical',
      actor,
      now,
    });
  }

  async verify(
    tx: PubTx,
    product: ProductRef,
    id: string,
    b: Body,
    access: PubAccess,
    actor: string,
    now: Date,
  ): Promise<OpOut<ClaimView>> {
    const expected = parseExpectedRevision(b.expectedRevision);
    const is = new Issues();
    const status = is.oneOf(
      b,
      'status',
      ['supported', 'unsupported', 'unknown', 'needs_review'] as const,
      true,
    );
    is.throwIfAny();
    const c = await tx.pubClaim.findFirst({
      where: { id, productId: product.id },
      include: {
        claimSourceClaimOf: {
          include: { source: { select: { usage: true, updatedAt: true } } },
        },
      },
    });
    if (!c) throw new PubError('PUB_NOT_FOUND');
    if (status === 'supported') {
      const ok = c.claimSourceClaimOf.some(
        (l) =>
          l.supports === 'yes' &&
          l.source.usage === 'allowed' &&
          l.checkedAt !== null &&
          l.checkedAt >= l.source.updatedAt,
      );
      if (!ok) {
        throw validationError([
          { field: 'status', code: 'no_supporting_source' },
        ]);
      }
    }
    const author = c.createdBy.startsWith('member:')
      ? c.createdBy.slice(7)
      : null;
    await casUpdate(tx.pubClaim, id, expected, {
      status,
      verifiedBy: status === 'needs_review' ? c.verifiedBy : actor,
      verifiedAt: status === 'needs_review' ? c.verifiedAt : now,
    });
    const negative =
      status === 'unsupported' ||
      (c.status === 'supported' && status !== 'supported');
    const cascade = negative
      ? await this.afterDecision(
          tx,
          product,
          c,
          `claim-verify:${id}:${expected + 1}`,
          actor,
          now,
        )
      : null;
    return {
      body: await loadClaim(tx, product.id, id),
      audit: [
        {
          objectType: 'claim',
          objectId: id,
          action: 'transition',
          fromStatus: c.status,
          toStatus: status!,
          meta: {
            selfReview: isSelfReview(access, 'claim.verify', author),
            risk: c.risk,
            tasksOpened: cascade?.tasksOpened ?? 0,
          },
        },
      ],
    };
  }
}
