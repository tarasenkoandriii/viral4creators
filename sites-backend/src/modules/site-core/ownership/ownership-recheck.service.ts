/**
 * Крон ядра `site-ownership-recheck` — ОДИН на QA и помощника (ТЗ
 * помощника §4.15, QA-ТЗ §4.9):
 *  1. `verified` с наступившим `expiresAt` (90 дней) → `expired` сразу,
 *     без сети;
 *  2. остальные `verified` — повторная проверка тем же способом токеном
 *     кабинета-владельца строки; токена ТОЧНО нет → `revoked`; не смогли
 *     проверить (таймаут, резолверы разошлись) — статус не трогаем, пишем
 *     `lastCheck`.
 *
 * Не требует контекста пользователя: всё — через `SitesDb.system(причина)`,
 * кабинет каждой строки берётся из неё самой. О льготе виджета крон не
 * знает (её считает `assertHostVerified` для `assist-widget`).
 *
 * Перепроверка НЕ продлевает 90 дней — иначе подтверждение не истекало бы
 * никогда («90 дней, затем повтор», QA §2.4). Продлевает только ручная
 * проверка человеком.
 *
 * Прогон ограничен по времени (`maxDuration` функции) и размеру пачки:
 * давно не проверенные — первыми, остаток — на следующий день.
 */

import { Injectable, Logger } from '@nestjs/common';
import type { SiteHost } from '@prisma/client';
import { SitesDb } from '../../../prisma/sites-db.service';
import {
  RECHECK_BATCH,
  RECHECK_CONCURRENCY,
  RECHECK_TIME_BUDGET_MS,
  VerifyMethod,
} from '../site-core.constants';
import { checkJson } from '../sites/host-view';
import { OwnershipChecker } from './ownership-checker';
import { mapLimit } from './ownership.service';

export interface RecheckResult {
  expired: number;
  checked: number;
  stillVerified: number;
  revoked: number;
  /** Не смогли проверить — статус оставлен. */
  inconclusive: number;
  /** Не успели в бюджет времени — завтра. */
  deferred: number;
  revokedHostIds: string[];
}

const REASON = 'крон site-ownership-recheck: все verified-хосты всех кабинетов';

@Injectable()
export class OwnershipRecheckService {
  private readonly logger = new Logger(OwnershipRecheckService.name);

  constructor(
    private readonly db: SitesDb,
    private readonly checker: OwnershipChecker,
  ) {}

  async run(
    now = new Date(),
    clock: () => number = () => Date.now(),
    budgetMs = RECHECK_TIME_BUDGET_MS,
  ): Promise<RecheckResult> {
    const startedAt = clock();
    const system = this.db.system(REASON);

    const expired = await system.siteHost.updateMany({
      where: { status: 'verified', expiresAt: { lte: now } },
      data: { status: 'expired' },
    });
    // Хост без срока при `verified` — дефект записи; честнее истечь.
    const noExpiry = await system.siteHost.updateMany({
      where: { status: 'verified', expiresAt: null },
      data: { status: 'expired' },
    });

    const hosts = await system.siteHost.findMany({
      where: { status: 'verified' },
      orderBy: { lastRecheckAt: { sort: 'asc', nulls: 'first' } },
      take: RECHECK_BATCH,
    });
    const accounts = await system.siteAccount.findMany({
      where: { id: { in: [...new Set(hosts.map((h) => h.accountId))] } },
      select: { id: true, verifyToken: true },
    });
    const tokenOf = new Map(accounts.map((a) => [a.id, a.verifyToken]));

    const result: RecheckResult = {
      expired: expired.count + noExpiry.count,
      checked: 0,
      stillVerified: 0,
      revoked: 0,
      inconclusive: 0,
      deferred: 0,
      revokedHostIds: [],
    };

    await mapLimit(hosts, RECHECK_CONCURRENCY, async (h) => {
      if (clock() - startedAt > budgetMs) {
        result.deferred++;
        return;
      }
      await this.recheckOne(h, tokenOf.get(h.accountId), now, result);
    });

    if (result.revoked > 0 || result.expired > 0) {
      // Уведомление «в оба бота» — модуль notify sites-backend ещё не
      // написан (решение координатора Э0, п.3); до него — лог.
      this.logger.warn(
        `site-ownership-recheck: expired=${result.expired}, revoked=${result.revoked} (${result.revokedHostIds.join(',')})`,
      );
    }
    return result;
  }

  private async recheckOne(
    h: SiteHost,
    token: string | undefined,
    now: Date,
    out: RecheckResult,
  ): Promise<void> {
    const system = this.db.system(REASON);
    if (!token) {
      out.inconclusive++;
      return;
    }
    const method: VerifyMethod =
      h.publicPlatform || (h.method !== 'file' && h.method !== 'meta')
        ? 'dns'
        : h.method;
    out.checked++;
    let r;
    try {
      r = await this.checker.check(
        method,
        { scheme: 'https', host: h.host, port: h.port },
        token,
      );
    } catch (e) {
      this.logger.error(
        `recheck ${h.id}: ${e instanceof Error ? e.message : String(e)}`,
      );
      out.inconclusive++;
      return;
    }
    const last = checkJson(r, now);
    // Условие `status: 'verified'` — чтобы не затереть то, что человек
    // сделал, пока крон ходил в сеть.
    const where = { id: h.id, status: 'verified' };
    if (r.ok) {
      await system.siteHost.updateMany({
        where,
        data: { lastRecheckAt: now, lastCheck: last },
      });
      out.stillVerified++;
    } else if (r.definitive) {
      const { count } = await system.siteHost.updateMany({
        where,
        data: {
          status: 'revoked',
          revokedAt: now,
          lastRecheckAt: now,
          lastCheck: last,
        },
      });
      if (count === 1) {
        await system.siteOwnershipChallenge.updateMany({
          where: { hostId: h.id, accountId: h.accountId, status: 'verified' },
          data: { status: 'revoked', revokedAt: now, lastRecheckAt: now },
        });
        out.revoked++;
        out.revokedHostIds.push(h.id);
      }
    } else {
      await system.siteHost.updateMany({
        where,
        data: { lastRecheckAt: now, lastCheck: last },
      });
      out.inconclusive++;
    }
  }
}
