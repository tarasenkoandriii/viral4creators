/**
 * AI Publisher, P-R — общие проверки операций раздела Reddit (раунд
 * исправлений внутреннего аудита P-R M1):
 *  - `insertOrDuplicate` — вставка под точкой сохранения: проигравший гонку
 *    за уникальный ключ получает тот же ответ, что при последовательном
 *    дубле — 409 `{reason:'duplicate', existingId}` (S3-1);
 *  - `assertParentsActive` — операции над объектами архивного проекта или
 *    сообщества → 409 `project_archived` / `community_archived` (S3-6);
 *  - `profileRefIssue` — ники и ссылки на профили в свободном тексте (S3-2).
 */
import { PubError } from '../core/errors';
import { pgCodeOf } from '../core/operation';
import type { PubTx } from '../core/ports';
import type { Issues } from '../content/input';
import { hasProfileRef } from './normalize';

const SAVEPOINT = 'pub_reddit_unique';

function isUniqueViolation(e: unknown): boolean {
  const prisma = (e as { code?: unknown } | null)?.code;
  return pgCodeOf(e) === '23505' || prisma === 'P2002';
}

/**
 * Вставка с дублем → 409 `{existingId}`. В READ COMMITTED нарушение
 * уникальности возникает после фиксации конкурента, поэтому после отката
 * к точке сохранения его строка уже видна и перечитывается. Не нашлась
 * (конфликт другого ключа) — исходная ошибка (`mapDbError` → `PUB_CONFLICT`).
 */
export async function insertOrDuplicate<T>(
  tx: PubTx,
  insert: () => Promise<T>,
  existing: () => Promise<string | null>,
): Promise<T> {
  await tx.$executeRawUnsafe(`SAVEPOINT ${SAVEPOINT}`);
  try {
    const out = await insert();
    await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${SAVEPOINT}`);
    return out;
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`);
    const id = await existing();
    if (!id) throw e;
    throw new PubError('PUB_CONFLICT', { reason: 'duplicate', existingId: id });
  }
}

/** Проект и (если задано) сообщество активны, иначе 409 (S3-6). */
export async function assertParentsActive(
  tx: PubTx,
  productId: string,
  projectId: string,
  communityId?: string,
): Promise<void> {
  const p = await tx.pubRedditProject.findFirst({
    where: { id: projectId, productId },
    select: { status: true },
  });
  if (!p) throw new PubError('PUB_NOT_FOUND');
  if (p.status !== 'active')
    throw new PubError('PUB_TRANSITION_INVALID', {
      reason: 'project_archived',
      from: p.status,
    });
  if (communityId === undefined) return;
  const c = await tx.pubRedditCommunity.findFirst({
    where: { id: communityId, productId },
    select: { status: true },
  });
  if (!c) throw new PubError('PUB_NOT_FOUND');
  if (c.status !== 'active')
    throw new PubError('PUB_TRANSITION_INVALID', {
      reason: 'community_archived',
      from: c.status,
    });
}

/** Ник/профиль в поле → `{field, code:'profile_ref'}` (если поле ещё без ошибки). */
export function profileRefIssue(
  is: Issues,
  field: string,
  value: string | null | undefined,
): void {
  if (hasProfileRef(value) && !is.list.some((x) => x.field === field))
    is.add(field, 'profile_ref');
}
