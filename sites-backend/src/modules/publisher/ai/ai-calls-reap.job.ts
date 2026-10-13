/**
 * AI Publisher — задание `ai-calls-reap` (tick, P-B2; проектный документ
 * §11.1, §15.1): вызов, оставшийся `running` дольше 10 минут (процесс
 * оборвался посреди модели), переводится в `timeout`; генерация остаётся
 * засчитанной, стоимость `unknown`, резерв AI-месяца ОСТАЁТСЯ (аудит S1-4:
 * неизвестное не ноль; поздний ответ модели дописывает факт и заменяет
 * резерв — `gateway-core.lateFact`; иначе резерв держится до закрытия
 * месяца как оценка расхода).
 *
 * Условный `UPDATE … WHERE status='running'`: если финализация процесса
 * успела раньше, задание строку не трогает (и наоборот — финализация не
 * перезапишет итог задания). Без `scope` — по всей базе (прод).
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { SitesDb } from '../../../prisma/sites-db.service';
import { AuditService } from '../core/audit';
import { PubContribution } from '../core/contributions';
import { OPERATION_TX_OPTIONS } from '../core/operation';
import type { CronJob, CronResult, PubCronContext, PubTx } from '../core/ports';
import { REAP_AFTER_MS } from './gateway-core';

const BATCH = 200;

@Injectable()
@PubContribution('cron-job')
export class AiCallsReapJob implements CronJob {
  readonly key = 'ai-calls-reap';
  readonly schedule = 'tick' as const;

  constructor(
    private readonly db: SitesDb,
    private readonly audit: AuditService,
  ) {}

  async run(ctx: PubCronContext): Promise<CronResult> {
    const system = this.db.system(
      'крон publisher ai-calls-reap: зависшие AI-вызовы всех кабинетов',
    );
    const before = new Date(ctx.now.getTime() - REAP_AFTER_MS);
    const scope = ctx.scope
      ? Prisma.sql`AND p."siteId" = ANY(${ctx.scope.siteIds}::text[])`
      : Prisma.empty;
    const rows = await system.$queryRaw<
      Array<{
        id: string;
        accountId: string;
        productId: string;
        generator: string;
        model: string;
        requestedAt: Date;
        requestedBy: string;
        kind: string;
        provider: string;
      }>
    >`
      SELECT c."id", c."accountId", c."productId", c."generator", c."model", c."requestedAt",
             c."requestedBy", p."kind", c."provider"
        FROM "sites"."pub_ai_calls" c
        JOIN "sites"."pub_products" p ON p."id" = c."productId"
       WHERE c."status" = 'running' AND c."requestedAt" < ${before}
         AND p."kind" <> 'restored' ${scope}
       ORDER BY c."requestedAt"
       LIMIT ${BATCH}`;
    let reaped = 0;
    for (const r of rows) {
      if (Date.now() > ctx.deadline.getTime()) break;
      const done = await this.db
        .forAccount(r.accountId)
        .$transaction(async (raw) => {
          const tx = raw as PubTx;
          const n = await tx.pubAiCall.updateMany({
            where: { id: r.id, status: 'running' },
            data: {
              status: 'timeout',
              finishedAt: ctx.now,
              errorCode: 'reaped',
              costStatus: 'unknown',
              costMicroUsd: null,
            },
          });
          if (n.count !== 1) return false;
          // Аудит S1-4: резерв месяца НЕ снимается — модель могла ответить и
          // списать деньги; стоимость неизвестна, оценка держится до сверки
          // (поздний факт дописывает финализация процесса, `lateFact`).
          await this.audit.write(tx, {
            accountId: r.accountId,
            productId: r.productId,
            actor: 'system:ai-calls-reap',
            objectType: 'ai_call',
            objectId: r.id,
            action: 'transition',
            fromStatus: 'running',
            toStatus: 'timeout',
            meta: { errorCode: 'reaped' },
          });
          return true;
        }, OPERATION_TX_OPTIONS);
      if (done) reaped++;
    }
    return { processed: reaped, details: { reaped, scanned: rows.length } };
  }
}
