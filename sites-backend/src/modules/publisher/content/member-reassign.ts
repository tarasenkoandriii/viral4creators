/**
 * AI Publisher, P-B1 — вклад `member-reassign` ключа `contents`
 * (проектный документ §4.1, §15.1 `members-reconcile`): материалы, за
 * которые отвечал удалённый участник, переходят владельцу кабинета (снимок
 * имени — «Учасник …xxxxxx», контактов нет). Без этого вклада задание
 * ядра отвечает `pending` (501) и пару не трогает.
 */
import { Injectable } from '@nestjs/common';
import {
  PubContribution,
  type MemberReassignContributor,
} from '../core/contributions';
import { PubPorts, type ProductRef, type PubTx } from '../core/ports';

@Injectable()
@PubContribution('member-reassign')
export class ContentsMemberReassign implements MemberReassignContributor {
  readonly key = 'contents' as const;

  constructor(private readonly ports: PubPorts) {}

  async reassign(
    tx: PubTx,
    product: ProductRef,
    fromMemberId: string,
    toMemberId: string,
    actor: string,
  ): Promise<number> {
    const rows = await tx.pubContent.findMany({
      where: { productId: product.id, ownerMemberId: fromMemberId },
      select: { id: true },
    });
    for (const r of rows) {
      await tx.pubContent.update({
        where: { id: r.id },
        data: {
          ownerMemberId: toMemberId,
          ownerDisplayName: `Учасник …${toMemberId.slice(-6)}`,
          revision: { increment: 1 },
        },
      });
      await this.ports.audit().write(tx, {
        accountId: product.accountId,
        productId: product.id,
        actor,
        objectType: 'content',
        objectId: r.id,
        action: 'assign',
        meta: { reason: 'member_removed', toMemberId },
      });
    }
    return rows.length;
  }
}
