/**
 * AI Publisher — получатели уведомлений о заявках (P-D, проектный документ
 * §15.2; Р-PUB-22): участники с АКТИВНОЙ ролью продукта `sales` или
 * `product_owner`, которые ещё состоят в кабинете. Если таких нет —
 * владелец(ы) кабинета: он неявно носит все роли, включая `sales`
 * (Р-PUB-2), и заявка не должна остаться без адресата (Р-PUB-D-6).
 *
 * Получатель — `memberId` (без контактов); telegramId и язык берёт
 * доставка (`notifications.service.ts`).
 */
import type { ProductRef, PubTx } from '../core/ports';

export const RECIPIENT_ROLES = ['sales', 'product_owner'] as const;

export async function leadRecipientIds(
  tx: PubTx,
  product: ProductRef,
): Promise<string[]> {
  const grants = await tx.pubRoleGrant.findMany({
    where: {
      productId: product.id,
      revokedAt: null,
      role: { in: [...RECIPIENT_ROLES] },
    },
    select: { memberId: true },
  });
  const ids = [...new Set(grants.map((g) => g.memberId))];
  if (ids.length) {
    const present = await tx.siteAccountMember.findMany({
      where: { id: { in: ids } },
      select: { id: true },
    });
    const ok = present.map((m) => m.id).sort();
    if (ok.length) return ok;
  }
  const owners = await tx.siteAccountMember.findMany({
    where: { role: 'owner' },
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  return owners.map((o) => o.id);
}

/**
 * Участник всё ещё вправе получать уведомления о заявках продукта (аудит
 * P-D S3-3): состоит в кабинете и либо его владелец (неявно все роли),
 * либо держит действующую роль `sales`/`product_owner` этого продукта.
 * Отозванная роль — уже не получатель.
 */
export async function isLeadRecipient(
  tx: Pick<PubTx, 'siteAccountMember' | 'pubRoleGrant'>,
  productId: string,
  memberId: string,
): Promise<boolean> {
  const member = await tx.siteAccountMember.findFirst({
    where: { id: memberId },
    select: { role: true },
  });
  if (!member) return false;
  if (member.role === 'owner') return true;
  const grant = await tx.pubRoleGrant.findFirst({
    where: {
      productId,
      memberId,
      revokedAt: null,
      role: { in: [...RECIPIENT_ROLES] },
    },
    select: { id: true },
  });
  return !!grant;
}

/** Владелец кабинета (исполнитель задач «владельцу», §15.1). */
export async function accountOwnerId(tx: PubTx): Promise<string | null> {
  const o = await tx.siteAccountMember.findFirst({
    where: { role: 'owner' },
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  return o?.id ?? null;
}
