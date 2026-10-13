/**
 * AI Publisher, P-B1 — отзыв источника (проектный документ §6.3, §11.3
 * `POST …/sources/:id/revoke`; AT-CORE-21, ТЗ «удаление разрешённого
 * ранее источника»).
 *
 * В одной транзакции:
 *  - `usage = revoked` (необратимо, триггер), `revoked*`, строка
 *    `pub_source_revocations` (AO; применяется при восстановлении, §15.4);
 *  - claims с поддержкой этим источником: подтверждённые → `needs_review`,
 *    задача `source_revoked` на claim;
 *  - версии со ссылкой на источник или на эти claims — каскад
 *    `source_revoked` (опубликованные → `correction_required` и задачи на
 *    публикации, неопубликованные согласования → `superseded`), адаптации
 *    — тоже; `criticalStale`, если источник подтверждал критический claim;
 *  - активные факты бренда, готовые брифы и выбранные вопросы с этим
 *    источником — задачи проверки;
 *  - из нового AI-контекста и общих выгрузок источник выпадает сразу
 *    (выборка по `usage` в момент запроса, кэша нет — §12.3).
 */
import { Injectable } from '@nestjs/common';
import type { RevokeSourceResponse } from '../contracts/content-api';
import { PubError } from '../core/errors';
import {
  PubPorts,
  type ProductRef,
  type PubTx,
  type ReviewItem,
} from '../core/ports';
import { ContentCascades } from './cascades';
import { Issues, type Body } from './input';
import { sourceChain } from './refs';
import type { OpOut } from './sources.service';
import { loadSource } from './views';

@Injectable()
export class RevocationService {
  constructor(
    private readonly cascades: ContentCascades,
    private readonly ports: PubPorts,
  ) {}

  async revoke(
    tx: PubTx,
    product: ProductRef,
    id: string,
    b: Body,
    actor: string,
    now: Date,
  ): Promise<OpOut<RevokeSourceResponse>> {
    const is = new Issues();
    const reason = is.str(b, 'reason', {
      required: true,
      max: 2000,
      pii: true,
    });
    is.throwIfAny();
    const cur = await tx.pubSource.findFirst({
      where: { id, productId: product.id },
    });
    if (!cur) throw new PubError('PUB_NOT_FOUND');
    if (cur.usage === 'revoked') {
      throw new PubError('PUB_TRANSITION_INVALID', {
        machine: 'source_usage',
        from: 'revoked',
        to: 'revoked',
        allowed: [],
      });
    }
    // Аудит P-B1 S1-1: отзыв права — на ВСЮ цепочку редакций (`supersedesId`
    // вверх и вниз): прежняя редакция того же текста не остаётся в
    // контексте, выгрузках и на странице.
    const chain = await sourceChain(tx, product.id, id);
    let rev: { id: string } | null = null;
    for (const sid of chain) {
      const row = await tx.pubSource.findFirst({
        where: { id: sid, productId: product.id },
        select: { usage: true },
      });
      if (!row || row.usage === 'revoked') continue;
      await tx.pubSource.update({
        where: { id: sid },
        data: {
          usage: 'revoked',
          revokedAt: now,
          revokedBy: actor,
          revokeReason: reason!,
          revision: { increment: 1 },
        },
      });
      const r = await tx.pubSourceRevocation.create({
        data: {
          accountId: product.accountId,
          productId: product.id,
          sourceId: sid,
          revokedAt: now,
          revokedBy: actor,
          reason: reason!,
          createdBy: actor,
        },
      });
      if (sid === id) rev = r;
    }
    if (!rev) throw new PubError('PUB_NOT_FOUND');
    const triggerRef = `revocation:${rev.id}`;
    const tasks: ReviewItem[] = [];

    // Claims с этим источником.
    const claimLinks = await tx.pubClaimSource.findMany({
      where: { productId: product.id, sourceId: { in: chain } },
      select: {
        supports: true,
        claim: { select: { id: true, status: true, risk: true } },
      },
    });
    let critical = false;
    const seenClaims = new Set<string>();
    for (const l of claimLinks) {
      if (l.supports === 'yes' && l.claim.risk === 'critical') critical = true;
      if (seenClaims.has(l.claim.id)) continue;
      seenClaims.add(l.claim.id);
      if (l.claim.status === 'supported') {
        await tx.pubClaim.update({
          where: { id: l.claim.id },
          data: { status: 'needs_review', revision: { increment: 1 } },
        });
      }
      tasks.push({
        objectType: 'claim',
        objectId: l.claim.id,
        reason: 'source_revoked',
        triggerRef,
        severity: l.claim.risk === 'critical' ? 'critical' : 'normal',
      });
    }
    const claimIds = [...seenClaims];
    const [versionLinks, claimVersions] = await Promise.all([
      tx.pubVersionSource.findMany({
        where: { productId: product.id, sourceId: { in: chain } },
        select: { versionId: true },
      }),
      tx.pubVersionClaim.findMany({
        where: { productId: product.id, claimId: { in: claimIds } },
        select: { versionId: true },
      }),
    ]);
    // Факты, брифы, вопросы — задачи на ручную проверку.
    const [facts, briefs, questions] = await Promise.all([
      tx.pubBrandFact.findMany({
        where: {
          productId: product.id,
          sourceId: { in: chain },
          status: 'active',
        },
        select: { id: true },
      }),
      tx.pubBriefSource.findMany({
        where: {
          productId: product.id,
          sourceId: { in: chain },
          brief: { status: 'ready' },
        },
        select: { briefId: true },
      }),
      tx.pubQuestionSource.findMany({
        where: {
          productId: product.id,
          sourceId: { in: chain },
          question: { status: 'selected' },
        },
        select: { questionId: true },
      }),
    ]);
    for (const f of facts) {
      tasks.push({
        objectType: 'brand_fact',
        objectId: f.id,
        reason: 'source_revoked',
        triggerRef,
        severity: 'normal',
      });
    }
    for (const briefId of new Set(briefs.map((x) => x.briefId))) {
      tasks.push({
        objectType: 'brief',
        objectId: briefId,
        reason: 'source_revoked',
        triggerRef,
        severity: 'normal',
      });
    }
    for (const questionId of new Set(questions.map((q) => q.questionId))) {
      tasks.push({
        objectType: 'question',
        objectId: questionId,
        reason: 'source_revoked',
        triggerRef,
        severity: 'normal',
      });
    }
    let opened = await this.ports.review().open(tx, product, tasks, { actor });
    const cascade = await this.cascades.run(tx, product, {
      reason: 'source_revoked',
      triggerRef,
      versionIds: [...versionLinks, ...claimVersions].map((v) => v.versionId),
      critical,
      actor,
      now,
    });
    opened += cascade.tasksOpened;
    return {
      body: {
        source: await loadSource(tx, product.id, id),
        revocationId: rev.id,
        tasksOpened: opened,
      },
      audit: [
        {
          objectType: 'source',
          objectId: id,
          action: 'revoke',
          fromStatus: cur.usage,
          toStatus: 'revoked',
          reason: reason!,
          meta: {
            revocationId: rev.id,
            tasksOpened: opened,
            correctionRequired: cascade.correctionRequired.length,
            approvalsSuperseded: cascade.approvalsSuperseded.length,
          },
        },
      ],
    };
  }
}
