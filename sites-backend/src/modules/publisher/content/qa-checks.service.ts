/**
 * AI Publisher, P-B1 — QA-проверки версии (проектный документ §6.3
 * `pub_qa_checks`, §7.1, §12.5; F04): редакционная и техническая проверка
 * человека, проверка сохранения смысла у адаптации. Только замороженная
 * версия (проверяется именно то, что будет согласовано). Самоаудит — при
 * совпадении с автором версии (`selfReview`, ТЗ §5). `ai_review` пишет шлюз
 * P-B2 (`system:ai-review`) — он НИКОГДА не учитывается в согласовании.
 */
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { QaCheckView } from '../contracts/content-api';
import { isRedditContentKind } from '../contracts/states';
import { PubError, validationError } from '../core/errors';
import type { ProductRef, PubTx } from '../core/ports';
import {
  can,
  isSelfReview,
  type PubAccess,
  type PubAction,
} from '../core/roles';
import { Issues, type Body } from './input';
import { ContentCascades, decidedVersionIds } from './cascades';
import { checkBlockers } from './rules';
import type { OpOut } from './sources.service';
import { qaView } from './views';

export const QA_ACTION: Record<
  'editorial' | 'technical' | 'adaptation_meaning',
  PubAction
> = {
  editorial: 'qa.editorial',
  technical: 'qa.technical',
  adaptation_meaning: 'qa.editorial',
};

@Injectable()
export class QaChecksService {
  constructor(private readonly cascades: ContentCascades) {}

  async create(
    tx: PubTx,
    product: ProductRef,
    versionId: string,
    b: Body,
    access: PubAccess,
    actor: string,
    now: Date,
  ): Promise<OpOut<QaCheckView>> {
    const is = new Issues();
    const kind = is.oneOf(
      b,
      'kind',
      ['editorial', 'technical', 'adaptation_meaning'] as const,
      true,
    );
    const result = is.oneOf(
      b,
      'result',
      ['pass', 'fail', 'unknown'] as const,
      true,
    );
    const bl = checkBlockers(b.blockers);
    bl.issues.forEach((x) => is.add(x.field, x.code));
    if (result === 'pass' && bl.blockers.length)
      is.add('blockers', 'pass_with_blockers');
    is.throwIfAny();
    const action = QA_ACTION[kind!];
    if (!can(access, action))
      throw new PubError('PUB_ROLE_REQUIRED', { action });
    const v = await tx.pubContentVersion.findFirst({
      where: { id: versionId, productId: product.id },
      include: {
        content: { select: { kind: true } },
        versionClaimVersionOf: {
          select: { claimId: true, claim: { select: { risk: true } } },
        },
      },
    });
    if (!v) throw new PubError('PUB_NOT_FOUND');
    if (!v.frozenAt) {
      throw new PubError('PUB_TRANSITION_INVALID', {
        machine: 'content_version',
        from: v.status,
        to: 'qa',
        allowed: [],
        hint: 'submit_first',
      });
    }
    if (
      kind === 'adaptation_meaning' &&
      (v.content.kind === 'article' || isRedditContentKind(v.content.kind))
    ) {
      throw validationError([{ field: 'kind', code: 'adaptation_only' }]);
    }
    const claimIds = new Set(v.versionClaimVersionOf.map((c) => c.claimId));
    bl.blockers.forEach((x, i) => {
      if (x.claimId && !claimIds.has(x.claimId))
        is.add(`blockers[${i}].claimId`, 'not_in_version');
    });
    is.throwIfAny();
    const row = await tx.pubQaCheck.create({
      data: {
        accountId: product.accountId,
        productId: product.id,
        versionId,
        kind: kind!,
        result: result!,
        blockers: bl.blockers as unknown as Prisma.InputJsonArray,
        checkedBy: actor,
        checkedAt: now,
        selfReview: isSelfReview(access, action, v.authorMemberId),
        createdBy: actor,
      },
    });
    // Аудит P-B1 S0-1: отрицательная проверка человека ПОСЛЕ согласования
    // (fail / unknown / блокеры) — каскад `stale_check`: согласование
    // неопубликованной версии снимается, показанная — на исправление
    // (`criticalStale`, если блокер про критический claim).
    let tasksOpened = 0;
    if (result !== 'pass' || bl.blockers.length > 0) {
      const decided = await decidedVersionIds(tx, product.id, [versionId]);
      if (decided.length) {
        const critical = bl.blockers.some((x) =>
          v.versionClaimVersionOf.some(
            (l) => l.claimId === x.claimId && l.claim.risk === 'critical',
          ),
        );
        const r = await this.cascades.run(tx, product, {
          reason: 'stale_check',
          triggerRef: `qa:${row.id}`,
          versionIds: decided,
          critical,
          actor,
          now,
        });
        tasksOpened = r.tasksOpened;
      }
    }
    return {
      body: qaView(row),
      audit: [
        {
          objectType: 'qa_check',
          objectId: row.id,
          action: 'create',
          toStatus: row.result,
          meta: {
            versionId,
            kind: row.kind,
            blockers: bl.blockers.length,
            selfReview: row.selfReview,
            tasksOpened,
          },
        },
      ],
    };
  }

  async list(
    tx: PubTx,
    productId: string,
    versionId: string,
  ): Promise<{ items: QaCheckView[] }> {
    const v = await tx.pubContentVersion.findFirst({
      where: { id: versionId, productId },
      select: { id: true },
    });
    if (!v) throw new PubError('PUB_NOT_FOUND');
    const rows = await tx.pubQaCheck.findMany({
      where: { productId, versionId },
      orderBy: [{ checkedAt: 'asc' }, { id: 'asc' }],
    });
    return { items: rows.map(qaView) };
  }
}
