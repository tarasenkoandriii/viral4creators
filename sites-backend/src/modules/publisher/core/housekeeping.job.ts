/**
 * AI Publisher — уборка (P-A1, проектный документ §15.1 `housekeeping`):
 *  - `housekeeping` (daily) — ключи идемпотентности с истёкшим `expiresAt`
 *    (30 дней Kyiv);
 *  - `rate-hits-sweep` (tick) — окна лимита формы `pub_rate_hits` старше
 *    1 ч (окно формы ≤ 600 с; сырой IP там и так не хранится).
 *
 * `pub_rate_hits` пишет P-D (§6.8); удаление просроченных строк здесь —
 * явное исключение `table-ownership.spec` по §15.1. Удаление blob копий
 * с `rotationUntil < now` — у P-E (задание `backup-rotation`: путь и ключ
 * копии знает только сервис бэкапа) — Р-PUB-A1-9.
 *
 * Без `scope` — по всей базе (прод); тест — только свои сайты.
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { SitesDb } from '../../../prisma/sites-db.service';
import { PubContribution } from './contributions';
import type { CronJob, CronResult, PubCronContext } from './ports';

export const RATE_HITS_TTL_MS = 60 * 60 * 1000;
const BATCH = 5000;

@Injectable()
@PubContribution('cron-job')
export class IdempotencyHousekeepingJob implements CronJob {
  readonly key = 'housekeeping';
  readonly schedule = 'daily' as const;

  constructor(private readonly db: SitesDb) {}

  async run(ctx: PubCronContext): Promise<CronResult> {
    const system = this.db.system(
      'крон publisher housekeeping: ключи идемпотентности всех кабинетов',
    );
    const scope = ctx.scope
      ? Prisma.sql`AND ("siteId" = ANY(${ctx.scope.siteIds}::text[])
                     OR "productId" IN (SELECT "id" FROM "sites"."pub_products"
                                         WHERE "siteId" = ANY(${ctx.scope.siteIds}::text[])))`
      : Prisma.empty;
    let removed = 0;
    for (;;) {
      if (Date.now() > ctx.deadline.getTime()) break;
      const n = await system.$executeRaw`
        DELETE FROM "sites"."pub_idempotency_keys"
         WHERE "id" IN (SELECT "id" FROM "sites"."pub_idempotency_keys"
                         WHERE "expiresAt" < ${ctx.now} ${scope}
                         LIMIT ${BATCH})`;
      removed += n;
      if (n < BATCH) break;
    }
    return { processed: removed, details: { idempotencyKeysRemoved: removed } };
  }
}

@Injectable()
@PubContribution('cron-job')
export class RateHitsSweepJob implements CronJob {
  readonly key = 'rate-hits-sweep';
  readonly schedule = 'tick' as const;

  constructor(private readonly db: SitesDb) {}

  async run(ctx: PubCronContext): Promise<CronResult> {
    const system = this.db.system(
      'крон publisher rate-hits-sweep: окна лимита вне кабинета',
    );
    const before = new Date(ctx.now.getTime() - RATE_HITS_TTL_MS);
    const scope = ctx.scope
      ? Prisma.sql`AND split_part("key", ':', 1) IN (SELECT "id" FROM "sites"."pub_products"
                                                     WHERE "siteId" = ANY(${ctx.scope.siteIds}::text[]))`
      : Prisma.empty;
    let removed = 0;
    for (;;) {
      if (Date.now() > ctx.deadline.getTime()) break;
      const n = await system.$executeRaw`
        DELETE FROM "sites"."pub_rate_hits"
         WHERE "id" IN (SELECT "id" FROM "sites"."pub_rate_hits"
                         WHERE "at" < ${before} ${scope}
                         LIMIT ${BATCH})`;
      removed += n;
      if (n < BATCH) break;
    }
    return { processed: removed, details: { rateHitsRemoved: removed } };
  }
}
