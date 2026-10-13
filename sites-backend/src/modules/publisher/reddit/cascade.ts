/**
 * AI Publisher, P-R — каскады раздела Reddit: перевод зависимых
 * возможностей сообщества в перепроверку при новой версии правил (§M1.3) и
 * при отзыве первоисточника действующих правил (аудит P-R S2-2; вызывает
 * отзыв источника P-B1 `RevocationService.revoke` в той же транзакции).
 * Пишет только `pub_reddit_opportunities` (пакет P-R); аудит — на каждую
 * возможность.
 */
import type { RedditPolicyReason } from '../contracts/reddit-api';
import type { RedditPolicyVerdict } from '../contracts/states';
import type { AuditInput, ProductRef, PubTx } from '../core/ports';

/** Статусы возможностей, которые изменение правил переводит в перепроверку. */
export const RECHECK_ON_RULES_CHANGE = [
  'new',
  'qualified',
  'in_brief',
] as const;

export async function recheckOpportunities(
  tx: PubTx,
  product: ProductRef,
  communityIds: string[],
  opts: {
    policy: RedditPolicyVerdict;
    reason: RedditPolicyReason;
    ruleSnapshotId: string | null;
  },
): Promise<AuditInput[]> {
  if (communityIds.length === 0) return [];
  const rows = await tx.pubRedditOpportunity.findMany({
    where: {
      productId: product.id,
      communityId: { in: communityIds },
      status: { in: [...RECHECK_ON_RULES_CHANGE] },
    },
    select: { id: true, status: true },
    orderBy: { id: 'asc' },
  });
  if (rows.length === 0) return [];
  await tx.pubRedditOpportunity.updateMany({
    where: { productId: product.id, id: { in: rows.map((r) => r.id) } },
    data: {
      policy: opts.policy,
      policyReasons: [opts.reason],
      status: 'recheck_required',
      revision: { increment: 1 },
    },
  });
  return rows.map((r) => ({
    objectType: 'reddit_opportunity' as const,
    objectId: r.id,
    action: 'transition' as const,
    fromStatus: r.status,
    toStatus: 'recheck_required',
    meta: { reason: opts.reason, ruleSnapshotId: opts.ruleSnapshotId },
  }));
}

/**
 * Отозван первоисточник (вся цепочка редакций `chain`) текущих снимков
 * правил: гейт этих сообществ — `block` (`rules_source_revoked`),
 * возможности → `recheck_required`.
 */
export async function redditOnSourceRevoked(
  tx: PubTx,
  product: ProductRef,
  chain: string[],
): Promise<AuditInput[]> {
  const snaps = await tx.pubRedditRuleSnapshot.findMany({
    where: {
      productId: product.id,
      status: 'current',
      sourceId: { in: chain },
    },
    select: { id: true, communityId: true },
  });
  const out: AuditInput[] = [];
  for (const s of snaps) {
    out.push(
      ...(await recheckOpportunities(tx, product, [s.communityId], {
        policy: 'block',
        reason: 'rules_source_revoked',
        ruleSnapshotId: s.id,
      })),
    );
  }
  return out;
}
