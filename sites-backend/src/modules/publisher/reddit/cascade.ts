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

/**
 * Блокировка строк сообществ продукта (порядок по id — без взаимных
 * блокировок). `FOR UPDATE` — смена правил (новый снимок, отзыв
 * первоисточника), `FOR SHARE` — расчёт гейта возможности по текущему
 * снимку (score, правка факторов, qualify, создание): расчёт и смена правил
 * сообщества сериализуются (аудит m1-2, сценарий «пропуск»).
 */
export async function lockCommunities(
  tx: PubTx,
  productId: string,
  communityIds: string[],
  mode: 'FOR UPDATE' | 'FOR SHARE',
): Promise<Array<{ id: string; status: string }>> {
  const ids = [...new Set(communityIds)].sort();
  return mode === 'FOR UPDATE'
    ? tx.$queryRaw<Array<{ id: string; status: string }>>`
        SELECT "id", "status" FROM "sites"."pub_reddit_communities"
         WHERE "productId" = ${productId} AND "id" = ANY(${ids}::text[])
         ORDER BY "id" FOR UPDATE`
    : tx.$queryRaw<Array<{ id: string; status: string }>>`
        SELECT "id", "status" FROM "sites"."pub_reddit_communities"
         WHERE "productId" = ${productId} AND "id" = ANY(${ids}::text[])
         ORDER BY "id" FOR SHARE`;
}

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
  // Аудит m1-2: строки берутся под блокировкой с фильтром статуса, и тот же
  // фильтр — в UPDATE. Параллельный `archive`/`skip` (зафиксирован раньше)
  // исключает строку из выборки: после ожидания блокировки Postgres
  // перепроверяет WHERE по новой версии строки (EvalPlanQual), поэтому
  // `archived`/`skipped` не воскресают, а аудит пишет фактический статус.
  const statuses: string[] = [...RECHECK_ON_RULES_CHANGE];
  const rows = await tx.$queryRaw<Array<{ id: string; status: string }>>`
    SELECT "id", "status" FROM "sites"."pub_reddit_opportunities"
     WHERE "productId" = ${product.id}
       AND "communityId" = ANY(${communityIds}::text[])
       AND "status" = ANY(${statuses}::text[])
     ORDER BY "id"
     FOR UPDATE`;
  if (rows.length === 0) return [];
  await tx.pubRedditOpportunity.updateMany({
    where: {
      productId: product.id,
      id: { in: rows.map((r) => r.id) },
      status: { in: statuses },
    },
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

/** Сообщества, у которых первоисточник ТЕКУЩЕГО снимка — в цепочке `chain`. */
export async function communitiesOfRulesSources(
  tx: PubTx,
  product: ProductRef,
  chain: string[],
): Promise<string[]> {
  const snaps = await tx.pubRedditRuleSnapshot.findMany({
    where: {
      productId: product.id,
      status: 'current',
      sourceId: { in: chain },
    },
    select: { communityId: true },
  });
  return [...new Set(snaps.map((s) => s.communityId))];
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
  // Аудит m1-2: сообщества — под блокировкой (как новый снимок), чтобы
  // параллельный пересчёт score/qualify (`FOR SHARE` сообщества) шёл либо до
  // отзыва (и попадал в каскад), либо после (и видел отзыв).
  const ids = await communitiesOfRulesSources(tx, product, chain);
  if (ids.length > 0) await lockCommunities(tx, product.id, ids, 'FOR UPDATE');
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
