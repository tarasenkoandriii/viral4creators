/**
 * AI Publisher — порты и вклады P-D для ядра (проектный документ §16.0,
 * отчёт P-A1 раздел 4 п.6–7):
 *
 *  - `RATE_LIMIT_RESET_PORT` — сброс окон лимита продукта (маршрут ядра
 *    `POST …/test/rate-limit/reset`, только `mode=test`/`kind=test`;
 *    AT-CORE-02 «между независимыми сценариями сбрасывать тестовый
 *    счётчик»). Удаляются все окна продукта (форма и события).
 *  - `member-reassign` с ключом `leads` — задание `members-reconcile`:
 *    открытые заявки удалённого участника переходят владельцу кабинета,
 *    его неотправленные уведомления — `dead` (`recipient_removed`), чтобы
 *    не висели в очереди.
 */
import { Injectable } from '@nestjs/common';
import {
  PubContribution,
  type MemberReassignContributor,
} from '../core/contributions';
import type { ProductRef, PubTx, RateLimitResetPort } from '../core/ports';

@Injectable()
export class LeadsRateLimitReset implements RateLimitResetPort {
  async reset(tx: PubTx, product: ProductRef): Promise<number> {
    // Ключ окна — `<productId>:<scope>:<hmac>` (public/rate-limit.ts).
    return tx.$executeRaw`
      DELETE FROM "sites"."pub_rate_hits" WHERE "key" LIKE ${`${product.id}:%`}`;
  }
}

@Injectable()
@PubContribution('member-reassign')
export class LeadsMemberReassign implements MemberReassignContributor {
  readonly key = 'leads' as const;

  async reassign(
    tx: PubTx,
    product: ProductRef,
    fromMemberId: string,
    toMemberId: string,
    _actor: string,
  ): Promise<number> {
    const leads = await tx.pubLead.updateMany({
      where: {
        productId: product.id,
        responsibleMemberId: fromMemberId,
        status: { notIn: ['rejected', 'won', 'lost'] },
      },
      data: {
        responsibleMemberId: toMemberId,
        responsibleDisplayName: `Учасник …${toMemberId.slice(-6)}`,
      },
    });
    await tx.pubNotification.updateMany({
      where: {
        productId: product.id,
        recipientMemberId: fromMemberId,
        status: { in: ['pending', 'failed', 'sending'] },
      },
      data: {
        status: 'dead',
        lastErrorCode: 'recipient_removed',
        leaseUntil: null,
      },
    });
    return leads.count;
  }
}
