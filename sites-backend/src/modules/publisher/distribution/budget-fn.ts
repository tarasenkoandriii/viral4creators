/**
 * AI Publisher — вызовы денежных функций `sites.pub_budget_*` (P-C,
 * проектный документ §8.2; миграция `20261016092000_publisher_budget_fn`).
 * Каждый вызов — ОДИН оператор `SELECT sites.pub_budget_…(…)` внутри
 * транзакции `runOperation`; ошибки предметной логики функция поднимает
 * как `RAISE '<КОД>' USING ERRCODE = 'P0001'`, здесь они переводятся в
 * `PubError` (иначе — 500). После ошибки транзакция Postgres уже прервана:
 * дочитывать в ней нечего, причину сервис уточняет ДО вызова (снимок).
 */
import { Prisma } from '@prisma/client';
import { PUB_ERROR_STATUS, type PubErrorCode } from '../contracts/errors';
import type { Minor } from '../contracts/common';
import { PubError, validationError } from '../core/errors';
import { pgCodeOf } from '../core/operation';
import type { PubTx } from '../core/ports';

const CODE_RE = /\b(PUB_[A-Z_]+)\b/;

function messagesOf(e: unknown): string {
  const seen = new Set<unknown>();
  const parts: string[] = [];
  const walk = (x: unknown, depth: number): void => {
    if (!x || typeof x !== 'object' || seen.has(x) || depth > 6) return;
    seen.add(x);
    const o = x as Record<string, unknown>;
    for (const k of ['message', 'originalMessage']) {
      if (typeof o[k] === 'string') parts.push(o[k] as string);
    }
    for (const k of ['cause', 'meta', 'driverAdapterError', 'error'])
      walk(o[k], depth + 1);
  };
  walk(e, 0);
  return parts.join(' | ');
}

/** Есть ли в цепочке ошибки SQLSTATE `code` (P0001 `pgCodeOf` пропускает). */
function hasCode(e: unknown, code: string): boolean {
  const seen = new Set<unknown>();
  const walk = (x: unknown, depth: number): boolean => {
    if (!x || typeof x !== 'object' || seen.has(x) || depth > 6) return false;
    seen.add(x);
    const o = x as Record<string, unknown>;
    if (o.originalCode === code || o.code === code) return true;
    if (
      typeof o.message === 'string' &&
      o.message.includes(`Code: \`${code}\``)
    )
      return true;
    return ['cause', 'meta', 'driverAdapterError', 'error'].some((k) =>
      walk(o[k], depth + 1),
    );
  };
  return walk(e, 0);
}

/**
 * Код P0001 функции → ошибка API. `PUB_BUDGET_COUNTERS_MISMATCH` — 409
 * `PUB_BUDGET_STOPPED {reason:'counters_mismatch'}`: новые обязательства
 * остановлены до разбора (ТЗ §17: превышения и дубли — ноль), откат уже
 * произошёл. `PUB_AMOUNT_EXCEEDS_OPEN` — 400 по полю суммы.
 */
export function budgetFnError(e: unknown): PubError | null {
  if (e instanceof PubError) return e;
  if (pgCodeOf(e) !== undefined || !hasCode(e, 'P0001')) return null;
  const m = CODE_RE.exec(messagesOf(e));
  if (!m) return null;
  const code = m[1];
  if (code === 'PUB_BUDGET_COUNTERS_MISMATCH') {
    return new PubError('PUB_BUDGET_STOPPED', { reason: 'counters_mismatch' });
  }
  if (code === 'PUB_AMOUNT_EXCEEDS_OPEN') {
    return validationError([{ field: 'amountMinor', code: 'range' }]);
  }
  if (code === 'PUB_GATE_CLOSED') {
    return new PubError('PUB_GATE_CLOSED', {
      gate: 'spend',
      missing: [
        { kind: 'budget', key: 'pub_budget_limits', detail: 'not_built' },
      ],
    });
  }
  if (code === 'PUB_BUDGET_STOPPED') {
    return new PubError('PUB_BUDGET_STOPPED', { reason: 'reconcile' });
  }
  if (code in PUB_ERROR_STATUS) return new PubError(code as PubErrorCode);
  return null;
}

async function call(tx: PubTx, sql: Prisma.Sql): Promise<string | null> {
  try {
    const rows = await tx.$queryRaw<Array<{ r: string | null }>>(sql);
    return rows[0]?.r ?? null;
  } catch (e) {
    throw budgetFnError(e) ?? e;
  }
}

const big = (v: Minor) => Prisma.sql`${v.toString()}::bigint`;
const txt = (v: string | null | undefined) => Prisma.sql`${v ?? null}::text`;
const ts = (v: Date | null | undefined) =>
  Prisma.sql`${v ?? null}::timestamptz`;

export interface ProductKey {
  id: string;
  accountId: string;
}

export interface FxCols {
  origCurrency: string | null;
  origAmountMinor: Minor | null;
  fxRate: string | null;
  fxSource: string | null;
  fxAt: Date | null;
}

export const budgetFn = {
  reserve(
    tx: PubTx,
    p: ProductKey,
    a: {
      amount: Minor;
      approvalId: string;
      priceSnapshotHash: string;
      placementId: string;
      revision: number;
      opKey: string;
      actor: string;
    },
  ): Promise<string | null> {
    return call(
      tx,
      Prisma.sql`SELECT "sites"."pub_budget_reserve"(${txt(p.id)}, ${txt(p.accountId)}, ${big(a.amount)},
        'placements', ${txt(a.approvalId)}, ${txt(a.priceSnapshotHash)}, ${txt(a.placementId)},
        ${a.revision}::int, ${txt(a.opKey)}, ${txt(a.actor)}) AS r`,
    );
  },

  commitTools(
    tx: PubTx,
    p: ProductKey,
    a: {
      amount: Minor;
      category: 'tools' | 'other';
      description: string;
      fx: FxCols;
      sourceDocument: string | null;
      opKey: string;
      actor: string;
    },
  ): Promise<string | null> {
    const fx = a.fx;
    return call(
      tx,
      Prisma.sql`SELECT "sites"."pub_budget_commit_tools"(${txt(p.id)}, ${txt(p.accountId)}, ${big(a.amount)},
        ${txt(a.category)}, ${txt(a.description)}, ${txt(fx.origCurrency)},
        ${fx.origAmountMinor === null ? Prisma.sql`NULL::bigint` : big(fx.origAmountMinor)},
        ${fx.fxRate}::numeric, ${txt(fx.fxSource)}, ${ts(fx.fxAt)}, ${txt(a.sourceDocument)},
        ${txt(a.opKey)}, ${txt(a.actor)}) AS r`,
    );
  },

  pay(
    tx: PubTx,
    p: ProductKey,
    a: EntryArgs & { status: 'confirmed' | 'pending' | 'unknown' },
  ): Promise<string | null> {
    return call(
      tx,
      Prisma.sql`SELECT "sites"."pub_budget_pay"(${txt(p.id)}, ${txt(p.accountId)}, ${txt(a.expenseId)},
        ${big(a.amount)}, ${txt(a.status)}, ${txt(a.externalRef)}, ${txt(a.sourceDocument)}, ${txt(a.note)},
        ${ts(a.occurredAt)}, ${txt(a.opKey)}, ${txt(a.actor)}) AS r`,
    );
  },

  refund(
    tx: PubTx,
    p: ProductKey,
    a: EntryArgs & { status: 'confirmed' | 'pending' },
  ): Promise<string | null> {
    return call(
      tx,
      Prisma.sql`SELECT "sites"."pub_budget_refund"(${txt(p.id)}, ${txt(p.accountId)}, ${txt(a.expenseId)},
        ${big(a.amount)}, ${txt(a.status)}, ${txt(a.externalRef)}, ${txt(a.sourceDocument)}, ${txt(a.note)},
        ${ts(a.occurredAt)}, ${txt(a.opKey)}, ${txt(a.actor)}) AS r`,
    );
  },

  cancel(tx: PubTx, p: ProductKey, a: EntryArgs): Promise<string | null> {
    return call(
      tx,
      Prisma.sql`SELECT "sites"."pub_budget_cancel"(${txt(p.id)}, ${txt(p.accountId)}, ${txt(a.expenseId)},
        ${big(a.amount)}, ${txt(a.sourceDocument)}, ${txt(a.note)}, ${ts(a.occurredAt)},
        ${txt(a.opKey)}, ${txt(a.actor)}) AS r`,
    );
  },

  deliver(tx: PubTx, p: ProductKey, a: EntryArgs): Promise<string | null> {
    return call(
      tx,
      Prisma.sql`SELECT "sites"."pub_budget_deliver"(${txt(p.id)}, ${txt(p.accountId)}, ${txt(a.expenseId)},
        ${big(a.amount)}, ${txt(a.sourceDocument)}, ${txt(a.note)}, ${ts(a.occurredAt)},
        ${txt(a.opKey)}, ${txt(a.actor)}) AS r`,
    );
  },

  adjust(
    tx: PubTx,
    p: ProductKey,
    a: EntryArgs & {
      approvalId: string | null;
      priceSnapshotHash: string | null;
    },
  ): Promise<string | null> {
    return call(
      tx,
      Prisma.sql`SELECT "sites"."pub_budget_adjust"(${txt(p.id)}, ${txt(p.accountId)}, ${txt(a.expenseId)},
        ${big(a.amount)}, ${txt(a.note)}, ${txt(a.approvalId)}, ${txt(a.priceSnapshotHash)},
        ${txt(a.sourceDocument)}, ${ts(a.occurredAt)}, ${txt(a.opKey)}, ${txt(a.actor)}) AS r`,
    );
  },

  reconcile(
    tx: PubTx,
    p: ProductKey,
    a: { entryId: string; status: 'confirmed' | 'void'; actor: string },
  ): Promise<string | null> {
    return call(
      tx,
      Prisma.sql`SELECT "sites"."pub_budget_reconcile"(${txt(p.id)}, ${txt(p.accountId)}, ${txt(a.entryId)},
        ${txt(a.status)}, ${txt(a.actor)}) AS r`,
    );
  },

  release(
    tx: PubTx,
    p: ProductKey,
    a: {
      toCategory: 'placements' | 'tools';
      amount: Minor;
      approvalId: string;
      actor: string;
    },
  ): Promise<string | null> {
    return call(
      tx,
      Prisma.sql`SELECT "sites"."pub_budget_release"(${txt(p.id)}, ${txt(p.accountId)}, ${txt(a.toCategory)},
        ${big(a.amount)}, ${txt(a.approvalId)}, ${txt(a.actor)}) AS r`,
    );
  },

  applyLimits(
    tx: PubTx,
    p: ProductKey,
    a: {
      currency: string;
      total: Minor;
      placements: Minor;
      tools: Minor;
      reserve: Minor;
      perPurchase: Minor;
      paramVersion: number;
      actor: string;
    },
  ): Promise<string | null> {
    return call(
      tx,
      Prisma.sql`SELECT "sites"."pub_budget_apply_limits"(${txt(p.id)}, ${txt(p.accountId)}, ${txt(a.currency)},
        ${big(a.total)}, ${big(a.placements)}, ${big(a.tools)}, ${big(a.reserve)}, ${big(a.perPurchase)},
        ${a.paramVersion}::int, ${txt(a.actor)}) AS r`,
    );
  },

  /**
   * Пересборка счётчиков из записей (решение владельца, Р-PUB-C-4):
   * исправленные головы и поправки счётчиков строки лимита.
   */
  async rebuildCounters(
    tx: PubTx,
    p: ProductKey,
  ): Promise<{
    heads: number;
    netPaid: number;
    openCommit: number;
    usedPlacements: number;
    usedTools: number;
  }> {
    const r = await call(
      tx,
      Prisma.sql`SELECT "sites"."pub_budget_rebuild_counters"(${txt(p.id)}, ${txt(p.accountId)}) AS r`,
    );
    return JSON.parse(r ?? '{}') as {
      heads: number;
      netPaid: number;
      openCommit: number;
      usedPlacements: number;
      usedTools: number;
    };
  },

  /** Расхождение счётчиков ('' — согласованы; null — строки лимита нет). */
  async drift(tx: PubTx, p: ProductKey): Promise<string | null> {
    const rows = await tx.$queryRaw<Array<{ d: string | null }>>`
      SELECT "sites"."pub_budget_drift"(${p.id}::text, ${p.accountId}::text) AS d`;
    return rows[0]?.d ?? null;
  },

  /** Эталон счётчиков из записей (для `budget-reconcile`, без блокировок). */
  async expected(
    tx: PubTx,
    productId: string,
  ): Promise<{
    netPaid: bigint;
    openCommit: bigint;
    usedPlacements: bigint;
    usedTools: bigint;
    aiMonth: bigint;
    headsBad: number;
  }> {
    const rows = await tx.$queryRaw<
      Array<{
        netPaid: bigint;
        openCommit: bigint;
        usedPlacements: bigint;
        usedTools: bigint;
        aiMonth: bigint;
        headsBad: number;
      }>
    >`SELECT * FROM "sites"."pub_budget_expected"(${productId}::text)`;
    return rows[0];
  },

  /** Ежедневная сверка остановила новые обязательства (открытая задача). */
  async stopped(tx: PubTx, productId: string): Promise<boolean> {
    const rows = await tx.$queryRaw<Array<{ s: boolean }>>`
      SELECT "sites"."pub_budget_stopped"(${productId}::text) AS s`;
    return rows[0]?.s === true;
  },
};

export interface EntryArgs {
  expenseId: string;
  amount: Minor;
  externalRef?: string | null;
  sourceDocument?: string | null;
  note?: string | null;
  occurredAt?: Date | null;
  opKey: string;
  actor: string;
}
