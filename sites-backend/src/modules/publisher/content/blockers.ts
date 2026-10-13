/**
 * AI Publisher, P-B1 — блокеры выпуска версии (§7.1 guard `editorial_review →
 * approved`; аудит P-B1 S0-1): одни и те же при согласовании, планировании,
 * публикации и в `ContentPort.publishableVersion` — отрицательное решение
 * человека после согласования (claim `unsupported`, QA `fail`) выпуск
 * останавливает.
 */
import type { ApprovalBlocker } from '../contracts/content-api';
import { PubError } from '../core/errors';
import type { PubTx } from '../core/ports';
import { CHANGE_TASK_REASONS } from './views';

/** Блокеры согласования версии (§7.1 guard `editorial_review → approved`). */
export async function approvalBlockers(
  tx: PubTx,
  productId: string,
  versionId: string,
): Promise<ApprovalBlocker[]> {
  const v = await tx.pubContentVersion.findFirst({
    where: { id: versionId, productId },
    include: {
      content: { select: { kind: true, parentContentId: true } },
      offerVersion: { select: { status: true } },
      versionClaimVersionOf: {
        select: { claim: { select: { id: true, risk: true, status: true } } },
      },
      versionSourceVersionOf: {
        select: { source: { select: { id: true, usage: true } } },
      },
      qaCheckVersionOf: {
        orderBy: [{ checkedAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      },
    },
  });
  if (!v) throw new PubError('PUB_NOT_FOUND');
  const out: ApprovalBlocker[] = [];
  const latest = (kind: string) =>
    v.qaCheckVersionOf.find((q) => q.kind === kind);
  const kinds: Array<[string, ApprovalBlocker['code']]> = [
    ['editorial', 'qa_editorial_missing'],
    ['technical', 'qa_technical_missing'],
  ];
  if (v.content.kind !== 'article')
    kinds.push(['adaptation_meaning', 'qa_adaptation_meaning_missing']);
  for (const [kind, code] of kinds) {
    const q = latest(kind);
    if (!q || q.result !== 'pass')
      out.push({ code, ...(q ? { id: q.id } : {}) });
    else if (Array.isArray(q.blockers) && q.blockers.length > 0)
      out.push({ code: 'qa_blocker', id: q.id });
  }
  for (const { claim } of v.versionClaimVersionOf) {
    if (claim.status === 'unsupported')
      out.push({ code: 'claim_unsupported', id: claim.id });
    else if (claim.risk === 'critical' && claim.status !== 'supported') {
      out.push({ code: 'claim_not_supported', id: claim.id });
    }
  }
  for (const { source } of v.versionSourceVersionOf) {
    if (source.usage !== 'allowed')
      out.push({ code: 'source_not_allowed', id: source.id });
  }
  if (v.offerVersion.status !== 'active')
    out.push({ code: 'offer_inactive', id: v.offerVersionId });
  const tasks = await tx.pubReviewTask.findMany({
    where: {
      productId,
      status: 'open',
      objectType: 'content_version',
      objectId: versionId,
      reason: { in: CHANGE_TASK_REASONS },
    },
    select: { id: true },
  });
  for (const t of tasks) out.push({ code: 'change_task_open', id: t.id });
  if (v.content.kind !== 'article') {
    const parentOk =
      v.parentVersionId !== null &&
      (await tx.pubApproval.count({
        where: {
          productId,
          type: 'publish_version',
          objectType: 'content_version',
          objectId: v.parentVersionId,
          status: 'active',
        },
      })) > 0;
    if (!parentOk)
      out.push({
        code: 'parent_not_approved',
        id: v.parentVersionId ?? undefined,
      });
  }
  return out;
}
