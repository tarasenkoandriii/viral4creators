/**
 * AI Publisher — задание `ai-calls-run` (очередь AI-вызовов, каждую минуту;
 * P-B2, решение координатора по аудиту S2-1, проектный документ §11.1,
 * §15.1).
 *
 * Маршрут исполняет вызов синхронно не дольше 25 с; не уложился — модель
 * прерывается, вызов остаётся `running` (202), аренда снята. Задание:
 *  1. берёт ОДИН вызов кабинета `running` с истёкшей арендой
 *     (`updatedAt` < now − `LEASE_MS`) и моложе срока `ai-calls-reap` —
 *     `UPDATE … SET updatedAt = now() … FOR UPDATE SKIP LOCKED` (два
 *     прохода/процесса один вызов не возьмут; путь крона ещё и под замком
 *     `publisher-minute`);
 *  2. перепроверяет то же, что маршрут (предаудит D2-03, `recheckCall`):
 *     действующее право автора на действие, гейт `ai_use` по текущей
 *     привязке, ту же конфигурацию; затем план из конверта (`planFromRow`):
 *     источники снимка проверяются ЗАНОВО. Не прошло → `refused` (код —
 *     `PUB_ROLE_REQUIRED` / `PUB_AI_NOT_EVALUATED` / `PUB_GATE_CLOSED` /
 *     `PUB_SOURCE_NOT_ALLOWED`), модель не зовётся, стоимость 0, резерв
 *     снимается (кроме оценки прерванной синхронной попытки, S1-4);
 *     автор `admin:<userId>` (оператор Админки) — ещё и свежее подтверждение
 *     backend по журналу доступа (`adminActorAttested`, IA-D1-03): нет —
 *     `refused` `PUB_ROLE_REQUIRED`;
 *  3. исполняет модель в остатке бюджета прохода; не хватило — снова
 *     передача следующему проходу (идемпотентно: итог пишется только
 *     условным `UPDATE … WHERE status='running'`).
 * Вызовы прогона набора (`system:eval`) и продуктов не `working|test` не
 * берутся. Без `scope` — по всей базе (прод).
 */
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { SitesDb } from '../../../prisma/sites-db.service';
import { AuditService } from '../core/audit';
import { PubContribution } from '../core/contributions';
import { PubError, isPubError } from '../core/errors';
import type { PubErrorCode } from '../contracts/errors';
import { OPERATION_TX_OPTIONS } from '../core/operation';
import {
  PubPorts,
  type CronJob,
  type CronResult,
  type PubCronContext,
  type PubTx,
} from '../core/ports';
import { adminActorAttested } from '../core/admin-attest';
import { AiGatewayService } from './ai-gateway.service';
import {
  LEASE_MS,
  REAP_AFTER_MS,
  planFromRow,
  recheckCall,
  refuseCall,
  type ExecPlan,
} from './gateway-core';

/** Меньше этого остатка прохода новый вызов не берём. */
const MIN_SLICE_MS = 5_000;
/** Запас на финализацию после модели. */
const FINALIZE_MARGIN_MS = 2_000;

interface ClaimedRow {
  id: string;
  accountId: string;
  productId: string;
  siteId: string;
  kind: string;
  taskId: string;
  instructionVersion: string;
  contextRulesVersion: string;
  attemptNo: number;
  generator: string;
  purpose: string;
  configId: string | null;
  provider: string;
  model: string;
  opKey: string;
  requestedBy: string;
  requestedAt: Date;
  output: unknown;
}

@Injectable()
@PubContribution('cron-job')
export class AiCallsRunJob implements CronJob {
  readonly key = 'ai-calls-run';
  readonly schedule = 'minute' as const;
  private readonly logger = new Logger('PublisherAiCallsRun');

  constructor(
    private readonly db: SitesDb,
    private readonly gateway: AiGatewayService,
    private readonly audit: AuditService,
    private readonly ports: PubPorts,
  ) {}

  private async claim(ctx: PubCronContext): Promise<ClaimedRow | null> {
    const system = this.db.system(
      'крон publisher ai-calls-run: очередь AI-вызовов всех кабинетов',
    );
    const leaseBefore = new Date(Date.now() - LEASE_MS);
    const reapBefore = new Date(ctx.now.getTime() - REAP_AFTER_MS);
    const scope = ctx.scope
      ? Prisma.sql`AND p."siteId" = ANY(${ctx.scope.siteIds}::text[])`
      : Prisma.empty;
    const rows = await system.$queryRaw<ClaimedRow[]>`
      WITH pick AS (
        SELECT c."id", p."siteId", p."kind"
          FROM "sites"."pub_ai_calls" c
          JOIN "sites"."pub_products" p ON p."id" = c."productId"
         WHERE c."status" = 'running'
           AND c."updatedAt" < ${leaseBefore}
           AND c."requestedAt" >= ${reapBefore}
           AND c."requestedBy" <> 'system:eval'
           AND p."kind" IN ('working', 'test') ${scope}
         ORDER BY c."requestedAt", c."id"
         LIMIT 1
           FOR UPDATE OF c SKIP LOCKED
      )
      UPDATE "sites"."pub_ai_calls" u
         SET "updatedAt" = now()
        FROM pick
       WHERE u."id" = pick."id" AND u."status" = 'running'
      RETURNING u."id", u."accountId", u."productId", pick."siteId", pick."kind", u."taskId",
                u."instructionVersion", u."contextRulesVersion",
                u."attemptNo", u."generator", u."purpose", u."configId", u."provider",
                u."model", u."opKey", u."requestedBy", u."requestedAt", u."output"`;
    return rows[0] ?? null;
  }

  async run(ctx: PubCronContext): Promise<CronResult> {
    let executed = 0;
    let refused = 0;
    let handedOff = 0;
    let failed = 0;
    for (;;) {
      const left = ctx.deadline.getTime() - Date.now();
      if (left < MIN_SLICE_MS) break;
      const row = await this.claim(ctx);
      if (!row) break;
      const tenant = this.db.forAccount(row.accountId);
      let plan: ExecPlan | null = null;
      try {
        // IA-D1-03: право оператора живёт в базе backend — подтверждение
        // по журналу доступа Админки (вне кабинета, до транзакции тенанта).
        if (!(await adminActorAttested(this.db, row.requestedBy))) {
          throw new PubError('PUB_ROLE_REQUIRED');
        }
        plan = await tenant.$transaction(async (raw) => {
          const tx = raw as PubTx;
          const denied = await recheckCall(
            tx,
            row,
            row.kind,
            this.ports.gates(),
            new Date(),
          );
          if (denied) throw new PubError(denied as PubErrorCode);
          return planFromRow(tx, row, row.siteId);
        }, OPERATION_TX_OPTIONS);
      } catch (e) {
        const code = isPubError(e) ? e.code : 'PUB_INTERNAL';
        const done = await tenant.$transaction(
          (tx) => refuseCall(tx as PubTx, row, code, this.audit),
          OPERATION_TX_OPTIONS,
        );
        if (done) refused++;
        continue;
      }
      const budget = ctx.deadline.getTime() - Date.now() - FINALIZE_MARGIN_MS;
      const r = await this.gateway.execute(plan, Math.max(1_000, budget));
      if (!r) failed++;
      else if (r.handedOff) handedOff++;
      else executed++;
      if (r?.handedOff) break; // бюджет прохода исчерпан
    }
    if (failed) this.logger.warn(`ai-calls-run: не завершено ${failed}`);
    return {
      processed: executed + refused,
      details: { executed, refused, handedOff, failed },
    };
  }
}
