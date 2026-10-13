/**
 * AI Publisher, P-B1 — вход канонического hash версии из базы (проектный
 * документ §6.3, аудит P2-14 и P-A1 P2-5; функция hash — `core/content-hash`).
 *
 * Контракт P-A1: метаданные источника, которые показывает страница
 * (`title`, `visibility`, `url`), и связи claim → источник (`supports`)
 * меняются без новой строки. Поэтому hash считается по их СНИМКУ при
 * заморозке версии (`submit`) и ПЕРЕСЧИТЫВАЕТСЯ по текущим значениям при
 * согласовании, планировании и публикации: расхождение с hash версии —
 * согласование недействительно (`PUB_APPROVAL_STALE`, нужна новая версия),
 * а не выпуск «как есть».
 */
import {
  contentVersionHash,
  type ContentHashInput,
} from '../core/content-hash';
import { PubError } from '../core/errors';
import type { PubTx } from '../core/ports';

export async function versionHashInput(
  tx: PubTx,
  productId: string,
  versionId: string,
): Promise<ContentHashInput> {
  const v = await tx.pubContentVersion.findFirst({
    where: { id: versionId, productId },
    include: {
      offerVersion: { select: { hash: true } },
      versionSourceVersionOf: {
        include: {
          source: {
            select: {
              id: true,
              contentHash: true,
              title: true,
              visibility: true,
              url: true,
            },
          },
        },
      },
      versionClaimVersionOf: {
        include: {
          claim: {
            select: {
              id: true,
              statement: true,
              type: true,
              risk: true,
              claimSourceClaimOf: {
                select: { claimId: true, sourceId: true, supports: true },
              },
            },
          },
        },
      },
      versionFactVersionOf: {
        include: { fact: { select: { id: true, version: true, value: true } } },
      },
    },
  });
  if (!v) throw new PubError('PUB_NOT_FOUND');
  return {
    title: v.title,
    body: v.body,
    meta: v.meta,
    format: v.format,
    offerVersionId: v.offerVersionId,
    offerHash: v.offerVersion.hash,
    parentVersionId: v.parentVersionId,
    sources: v.versionSourceVersionOf.map((x) => ({
      id: x.source.id,
      contentHash: x.source.contentHash,
      title: x.source.title,
      visibility: x.source.visibility,
      url: x.source.url,
    })),
    claims: v.versionClaimVersionOf.map((x) => ({
      id: x.claim.id,
      statement: x.claim.statement,
      type: x.claim.type,
      risk: x.claim.risk,
    })),
    facts: v.versionFactVersionOf.map((x) => ({
      id: x.fact.id,
      version: x.fact.version,
      value: x.fact.value,
    })),
    claimSources: v.versionClaimVersionOf.flatMap((x) =>
      x.claim.claimSourceClaimOf.map((cs) => ({
        claimId: cs.claimId,
        sourceId: cs.sourceId,
        supports: cs.supports,
      })),
    ),
  };
}

/** Hash версии по ТЕКУЩЕМУ состоянию связанных объектов. */
export async function currentVersionHash(
  tx: PubTx,
  productId: string,
  versionId: string,
): Promise<string> {
  return contentVersionHash(await versionHashInput(tx, productId, versionId));
}

/**
 * Замороженный hash версии всё ещё соответствует текущему состоянию
 * (иначе — `PUB_APPROVAL_STALE {reason:'hash_mismatch'}`).
 */
export async function assertHashCurrent(
  tx: PubTx,
  productId: string,
  versionId: string,
  frozenHash: string | null,
): Promise<void> {
  const now = await currentVersionHash(tx, productId, versionId);
  if (!frozenHash || now !== frozenHash) {
    throw new PubError('PUB_APPROVAL_STALE', {
      reason: 'hash_mismatch',
      versionId,
      versionHash: frozenHash,
      currentHash: now,
    });
  }
}
