/**
 * `assertHostVerified(hostId, purpose)` как сервис Nest — для модулей
 * помощника и QA (правило — в host-access.ts).
 *
 * `accountId` в опциях — когда вызывающий уже знает кабинет (маршрут
 * кабинета): запрос идёт через `forAccount`, и хост чужого кабинета
 * просто «не найден». Без него (виджет по `pk`, крон QA) — системное
 * чтение по id: строка хоста сама несёт свой кабинет.
 */

import { Injectable } from '@nestjs/common';
import type { SiteHost } from '@prisma/client';
import { SitesDb } from '../../../prisma/sites-db.service';
import { forbidden, notFoundHost } from '../site-core.constants';
import { optOutCandidates } from '../hosts/host-normalize';
import {
  HostAccessDecision,
  HostPurpose,
  evaluateHostAccess,
} from './host-access';

export interface AssertHostOptions {
  accountId?: string;
  now?: Date;
}

const REASON_TEXT: Record<'not_verified' | 'expired' | 'revoked', string> = {
  not_verified: 'Владение этим хостом не подтверждено',
  expired: 'Подтверждение владения хостом истекло — пройдите проверку заново',
  revoked: 'Подтверждение владения хостом отозвано — пройдите проверку заново',
};

@Injectable()
export class HostAccessService {
  constructor(private readonly db: SitesDb) {}

  /**
   * Бросает 403 `HOST_NOT_VERIFIED`/`HOST_OPTED_OUT`; возвращает строку
   * хоста и решение (в т.ч. `grace: true` — для плашки «72 ч льготы»).
   */
  async assertHostVerified(
    hostId: string,
    purpose: HostPurpose,
    opts: AssertHostOptions = {},
  ): Promise<{ host: SiteHost; decision: HostAccessDecision & { ok: true } }> {
    const now = opts.now ?? new Date();
    const host = opts.accountId
      ? await this.db
          .forAccount(opts.accountId)
          .siteHost.findFirst({ where: { id: hostId } })
      : await this.db
          .system(
            'assertHostVerified: хост по id (виджет/QA без кабинета в запросе)',
          )
          .siteHost.findUnique({ where: { id: hostId } });
    if (!host) throw notFoundHost();

    const optedOut = await this.db.guarded.siteOptOutDomain.findFirst({
      where: { domain: { in: optOutCandidates(host.host) } },
    });
    if (optedOut) {
      throw forbidden(
        'HOST_OPTED_OUT',
        'Владелец домена отказался от проверок и обходов',
      );
    }

    const decision = evaluateHostAccess(host, purpose, now);
    if (!decision.ok) {
      throw forbidden('HOST_NOT_VERIFIED', REASON_TEXT[decision.reason]);
    }
    return { host, decision };
  }
}
