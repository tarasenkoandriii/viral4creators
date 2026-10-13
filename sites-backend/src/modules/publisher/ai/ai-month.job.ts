/**
 * AI Publisher — задание `ai-month-open` (tick, P-B2; проектный документ
 * §12.1 «Потолок AI в бюджете», §15.1, Р-PUB-9; аудит S3-6).
 *
 * Для рабочего и тестового продукта с утверждёнными `ai_budget_usd_month`
 * и `ai_fx_rate`: открыть месяц Kyiv — строка `pub_ai_budget_months` с
 * потолком и ОБЯЗАТЕЛЬСТВО категории `tools` на ту же сумму по
 * утверждённому курсу (функция P-C `sites.pub_budget_commit_tools`, под
 * гейтом `spend` — через `GatePort`): деньги на AI зарезервированы в лимите
 * заранее, AI не тратит сверх остатка. Строка месяца без обязательства не
 * создаётся: гейт `spend` закрыт или бюджет не вмещает — продукт пропущен
 * (в `details`), вызовы получают `PUB_AI_BUDGET {month_not_open}`; функций
 * P-C в базе нет — `pending` (крон 501, не «успех», §16.0). Закрытие
 * неизрасходованного остатка прошлого месяца — отмена части обязательств
 * функцией P-C `pub_budget_cancel` в той же транзакции.
 *
 * Смена утверждённого потолка посреди месяца (аудит S3-6) — в течение
 * прохода tick: рост — дополнительное обязательство `tools` на разницу (тот
 * же документ `ai_budget_usd_month@YYYY-MM`, под гейтом `spend`; бюджет не
 * вмещает — потолок месяца прежний); снижение — отмена части обязательств,
 * но не ниже уже израсходованного и зарезервированного. Обязательства
 * месяца — все расходы `tools` с этим документом (строка месяца хранит
 * первое). Закрытие месяца отменяет всё открытое сверх `spent + reserved`
 * (резерв неизвестной стоимости — S1-4 — не отменяется).
 *
 * Вызовы функций P-C — именованными аргументами по их сигнатурам
 * (`20261016092000_publisher_budget_fn`); расхождение — ошибка задания
 * (500), а не тихий пропуск.
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { SitesDb } from '../../../prisma/sites-db.service';
import { AuditService } from '../core/audit';
import { isPubError } from '../core/errors';
import { PubContribution } from '../core/contributions';
import { kyivMonthOf } from '../core/kyiv-time';
import { convertMinor, divRound } from '../core/money';
import { OPERATION_TX_OPTIONS } from '../core/operation';
import { PubPorts } from '../core/ports';
import type { CronJob, CronResult, PubCronContext, PubTx } from '../core/ports';
import { aiRowId, derivedOpKey } from './gateway-core';

export const COMMIT_TOOLS_FN = 'pub_budget_commit_tools';
export const CANCEL_FN = 'pub_budget_cancel';
const ACTOR = 'system:ai-month-open';

/** Потолок месяца в валюте лимита: центы USD (вверх) × курс (вверх). */
export function monthCommitMinor(capMicroUsd: bigint, fxRate: string): bigint {
  const cents = divRound(capMicroUsd, 10_000n, 'ceil');
  return convertMinor(cents, fxRate, 'ceil');
}

/** Пропуск продукта (бюджет не вмещает потолок месяца) — откат его транзакции. */
class MonthSkip extends Error {}

/** Предыдущий месяц `YYYY-MM`. */
export function previousMonth(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

/** Детерминированный opKey операции месяца (повтор задания — та же операция). */
export function monthOpKey(
  productId: string,
  month: string,
  what: string,
): string {
  return derivedOpKey(`${productId}:${month}`, what);
}

@Injectable()
@PubContribution('cron-job')
export class AiMonthOpenJob implements CronJob {
  readonly key = 'ai-month-open';
  readonly schedule = 'tick' as const;

  constructor(
    private readonly db: SitesDb,
    private readonly audit: AuditService,
    private readonly ports: PubPorts,
  ) {}

  private async fnExists(name: string): Promise<boolean> {
    const rows = await this.db.system(
      'крон publisher ai-month-open: функции бюджета P-C',
    ).$queryRaw<
      Array<{ n: number }>
    >`SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace
       WHERE s.nspname = 'sites' AND p.proname = ${name}`;
    return (rows[0]?.n ?? 0) > 0;
  }

  async run(ctx: PubCronContext): Promise<CronResult> {
    const system = this.db.system(
      'крон publisher ai-month-open: продукты всех кабинетов',
    );
    const month = kyivMonthOf(ctx.now);
    const scope = ctx.scope
      ? Prisma.sql`AND p."siteId" = ANY(${ctx.scope.siteIds}::text[])`
      : Prisma.empty;
    const products = await system.$queryRaw<
      Array<{
        id: string;
        accountId: string;
        cap: unknown;
        fx: unknown;
        monthCap: bigint | null;
      }>
    >`
      SELECT p."id", p."accountId",
             cap."value" AS "cap", fx."value" AS "fx",
             (SELECT m."capMicroUsd" FROM "sites"."pub_ai_budget_months" m
               WHERE m."productId" = p."id" AND m."month" = ${month}) AS "monthCap"
        FROM "sites"."pub_products" p
        JOIN "sites"."pub_parameters" cap ON cap."productId" = p."id" AND cap."key" = 'ai_budget_usd_month' AND cap."status" = 'approved'
        JOIN "sites"."pub_parameters" fx ON fx."productId" = p."id" AND fx."key" = 'ai_fx_rate' AND fx."status" = 'approved'
       WHERE p."kind" IN ('working', 'test') AND p."status" = 'active' ${scope}`;
    const capOf = (p: { cap: unknown }): bigint =>
      BigInt(String((p.cap as { microUsd?: unknown })?.microUsd ?? 0));
    const work = products.filter(
      (p) => p.monthCap === null || BigInt(p.monthCap) !== capOf(p),
    );
    if (work.length === 0)
      return { processed: 0, details: { month, open: 0, adjusted: 0 } };
    const pending: string[] = [];
    if (!(await this.fnExists(COMMIT_TOOLS_FN)))
      pending.push(`${COMMIT_TOOLS_FN} (P-C)`);
    if (!(await this.fnExists(CANCEL_FN))) pending.push(`${CANCEL_FN} (P-C)`);
    if (pending.length) {
      // Без обязательства в бюджете месяц не открывается (Р-PUB-9).
      return {
        processed: 0,
        details: { month, waiting: work.length },
        pending,
      };
    }
    let opened = 0;
    let adjusted = 0;
    let gateClosed = 0;
    let insufficient = 0;
    for (const p of work) {
      if (Date.now() > ctx.deadline.getTime()) break;
      const capMicro = capOf(p);
      const fx = (p.fx ?? {}) as {
        rate?: unknown;
        source?: unknown;
        at?: unknown;
      };
      const rate = String(fx.rate ?? '');
      const r = await this.db
        .forAccount(p.accountId)
        .$transaction(async (raw) => {
          const tx = raw as PubTx;
          const ref = { id: p.id, accountId: p.accountId };
          const gateOpen = async (): Promise<boolean> => {
            try {
              await this.ports
                .gates()
                .assertOpen(tx, ref, 'spend', ctx.now, { category: 'tools' });
              return true;
            } catch (e) {
              if (isPubError(e, 'PUB_GATE_CLOSED')) return false;
              throw e;
            }
          };
          const commit = async (
            amountMinor: bigint,
            usdMicro: bigint,
            opKey: string,
            what: string,
          ): Promise<string> => {
            try {
              const rows = await tx.$queryRaw<Array<{ id: string }>>`
                SELECT "sites"."pub_budget_commit_tools"(
                  p_product => ${p.id}, p_account => ${p.accountId}, p_amount => ${amountMinor},
                  p_cat => 'tools', p_description => ${`AI ${month}: ${what}`},
                  p_orig_currency => 'USD', p_orig_amount => ${divRound(usdMicro, 10_000n, 'ceil')},
                  p_fx_rate => ${rate}::numeric, p_fx_source => ${typeof fx.source === 'string' ? fx.source : null},
                  p_fx_at => ${typeof fx.at === 'string' ? new Date(fx.at) : null},
                  p_source_doc => ${monthDocument(month)},
                  p_opkey => ${opKey},
                  p_actor => ${ACTOR}) AS "id"`;
              return rows[0].id;
            } catch (e) {
              if (
                /PUB_BUDGET_(INSUFFICIENT|STOPPED)/.test(
                  String((e as Error)?.message),
                )
              ) {
                throw new MonthSkip('insufficient');
              }
              throw e;
            }
          };

          if (p.monthCap === null) {
            if (!(await gateOpen())) return 'gate' as const;
            await this.closePrevious(tx, p, month, rate);
            const expenseId = await commit(
              monthCommitMinor(capMicro, rate),
              capMicro,
              monthOpKey(p.id, month, 'ai-month-commit'),
              'потолок',
            );
            const id = aiRowId('aim');
            await tx.$executeRaw`
              INSERT INTO "sites"."pub_ai_budget_months"
                ("id", "accountId", "productId", "month", "capMicroUsd", "expenseId", "createdBy")
              VALUES (${id}, ${p.accountId}, ${p.id}, ${month}, ${capMicro}, ${expenseId}, ${ACTOR})`;
            await this.audit.write(tx, {
              accountId: p.accountId,
              productId: p.id,
              actor: ACTOR,
              objectType: 'ai_budget_month',
              objectId: id,
              action: 'create',
              // суммы — в строке месяца и расходе P-C; в meta только ссылки
              // (длинные числа похожи на телефон — pii-guard журнала)
              meta: { month, expenseId },
            });
            return 'opened' as const;
          }

          // Смена потолка посреди месяца (S3-6): строка месяца под блокировкой.
          const rows = await tx.$queryRaw<
            Array<{
              id: string;
              capMicroUsd: bigint;
              spentMicroUsd: bigint;
              reservedMicroUsd: bigint;
              revision: number;
            }>
          >`
            SELECT "id", "capMicroUsd", "spentMicroUsd", "reservedMicroUsd", "revision"
              FROM "sites"."pub_ai_budget_months"
             WHERE "productId" = ${p.id} AND "accountId" = ${p.accountId} AND "month" = ${month}
               FOR UPDATE`;
          const m = rows[0];
          if (!m || m.capMicroUsd === capMicro) return 'none' as const;
          const committed = await monthCommittedMinor(tx, p.id, month);
          const salt = `ai-month-cap:${m.revision}`;
          if (capMicro > m.capMicroUsd) {
            const delta = monthCommitMinor(capMicro, rate) - committed.net;
            if (delta > 0n) {
              if (!(await gateOpen())) return 'gate' as const;
              await commit(
                delta,
                capMicro - m.capMicroUsd,
                monthOpKey(p.id, month, salt),
                'зміна потолку',
              );
            }
          } else {
            // Не ниже израсходованного и зарезервированного (неизвестное
            // не ноль): отменяется только свободная часть.
            const floorMicro =
              capMicro > m.spentMicroUsd + m.reservedMicroUsd
                ? capMicro
                : m.spentMicroUsd + m.reservedMicroUsd;
            await cancelDown(
              tx,
              p,
              month,
              committed,
              monthCommitMinor(floorMicro, rate),
              salt,
              `AI ${month}: зниження потолку`,
            );
          }
          await tx.$executeRaw`
            UPDATE "sites"."pub_ai_budget_months"
               SET "capMicroUsd" = ${capMicro}, "revision" = "revision" + 1, "updatedAt" = now()
             WHERE "id" = ${m.id} AND "accountId" = ${p.accountId}`;
          await this.audit.write(tx, {
            accountId: p.accountId,
            productId: p.id,
            actor: ACTOR,
            objectType: 'ai_budget_month',
            objectId: m.id,
            action: 'update',
            meta: {
              month,
              change: capMicro > m.capMicroUsd ? 'raise' : 'lower',
            },
          });
          return 'adjusted' as const;
        }, OPERATION_TX_OPTIONS)
        .catch((e: unknown) => {
          if (e instanceof MonthSkip) return 'insufficient' as const;
          throw e;
        });
      if (r === 'opened') opened++;
      else if (r === 'adjusted') adjusted++;
      else if (r === 'gate') gateClosed++;
      else if (r === 'insufficient') insufficient++;
    }
    return {
      processed: opened + adjusted,
      details: {
        month,
        open: opened,
        adjusted,
        spendGateClosed: gateClosed,
        insufficient,
      },
    };
  }

  /**
   * Закрытие прошлого месяца: всё открытое в его обязательствах сверх
   * `spent + reserved` (в валюте лимита, вверх) — отмена. Резерв
   * неизвестной стоимости (S1-4) остаётся обязательством.
   */
  private async closePrevious(
    tx: PubTx,
    p: { id: string; accountId: string },
    month: string,
    rate: string,
  ): Promise<void> {
    const prevMonth = previousMonth(month);
    const prev = await tx.pubAiBudgetMonth.findFirst({
      where: { productId: p.id, month: prevMonth },
      select: { spentMicroUsd: true, reservedMicroUsd: true },
    });
    if (!prev) return;
    const committed = await monthCommittedMinor(tx, p.id, prevMonth);
    await cancelDown(
      tx,
      p,
      prevMonth,
      committed,
      monthCommitMinor(prev.spentMicroUsd + prev.reservedMicroUsd, rate),
      'ai-month-close',
      `AI ${prevMonth}: не використано`,
    );
  }
}

/** Документ-основание обязательств месяца (все расходы месяца — по нему). */
export function monthDocument(month: string): string {
  return `ai_budget_usd_month@${month}`;
}

interface Committed {
  /** Обязательство за вычетом отменённого (валюта лимита). */
  net: bigint;
  /** Открытые части по расходам, новые первыми. */
  open: Array<{ id: string; open: bigint }>;
}

/** Обязательства месяца: расходы `tools` с документом месяца. */
async function monthCommittedMinor(
  tx: PubTx,
  productId: string,
  month: string,
): Promise<Committed> {
  const rows = await tx.pubExpense.findMany({
    where: {
      productId,
      category: 'tools',
      sourceDocument: monthDocument(month),
    },
    select: {
      id: true,
      amountTotalMinor: true,
      paidMinor: true,
      cancelledMinor: true,
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
  return {
    net: rows.reduce((a, r) => a + r.amountTotalMinor - r.cancelledMinor, 0n),
    open: rows.map((r) => ({
      id: r.id,
      open: r.amountTotalMinor - r.paidMinor - r.cancelledMinor,
    })),
  };
}

/** Отмена открытого сверх `targetMinor` — по расходам месяца, новые первыми. */
async function cancelDown(
  tx: PubTx,
  p: { id: string; accountId: string },
  month: string,
  committed: Committed,
  targetMinor: bigint,
  salt: string,
  note: string,
): Promise<bigint> {
  let left = committed.net - targetMinor;
  let cancelled = 0n;
  for (const e of committed.open) {
    if (left <= 0n) break;
    const amount = e.open < left ? e.open : left;
    if (amount <= 0n) continue;
    await tx.$queryRaw`
      SELECT "sites"."pub_budget_cancel"(
        p_product => ${p.id}, p_account => ${p.accountId}, p_expense => ${e.id},
        p_amount => ${amount}, p_source_doc => ${monthDocument(month)},
        p_note => ${note}, p_occurred_at => ${new Date()},
        p_opkey => ${monthOpKey(p.id, month, `${salt}:${e.id}`)}, p_actor => ${ACTOR})`;
    left -= amount;
    cancelled += amount;
  }
  return cancelled;
}
