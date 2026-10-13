/**
 * AI Publisher, P-C — общие куски контроллеров зоны: мутации через
 * `runOperation`, списки с курсором и выгрузкой `?format=csv` (§11.1: без
 * контактов, формулы экранированы, аудит `export`).
 *
 * Список, умеющий CSV, отвечает сам (`@Res()`): общий перехватчик обернул
 * бы файл в конверт. JSON такого списка — тот же конверт `{success, data,
 * meta}`, что ставит перехватчик.
 */
import { randomUUID } from 'crypto';
import type { Response } from 'express';
import {
  LIST_LIMIT_DEFAULT,
  LIST_LIMIT_MAX,
  type ListPage,
} from '../contracts/common';
import { PUB_NO_STORE, PubError, validationError } from '../core/errors';
import { jsonSafe } from '../core/money';
import type { OperationRef, PubOperations } from '../core/operation';
import type { AuditInput, PubTx } from '../core/ports';
import type { PubRequestCtx } from '../core/pub-role.guard';
import type { PubAction } from '../core/roles';
import { bodyOf, toCsv } from './input';

export function productOf(ctx: PubRequestCtx) {
  if (!ctx.product) throw new PubError('PUB_NOT_FOUND');
  return ctx.product;
}

export function sendEnvelope(res: Response, data: unknown, status = 200): void {
  res
    .status(status)
    .setHeader('Cache-Control', PUB_NO_STORE)
    .json({
      success: true,
      data: jsonSafe(data),
      meta: { timestamp: new Date().toISOString(), requestId: randomUUID() },
    });
}

export function sendCsv(res: Response, name: string, csv: string): void {
  res
    .status(200)
    .set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Cache-Control': PUB_NO_STORE,
      'Content-Disposition': `attachment; filename="publisher-${name}.csv"`,
    })
    .send(csv);
}

export function formatOf(v: unknown): 'json' | 'csv' {
  if (v === undefined || v === '' || v === 'json') return 'json';
  if (v === 'csv') return 'csv';
  throw validationError([{ field: 'format', code: 'enum' }]);
}

export function limitOf(v: unknown, csv: boolean): number {
  if (csv) return 5000;
  if (v === undefined || v === '') return LIST_LIMIT_DEFAULT;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) {
    throw validationError([{ field: 'limit', code: 'range' }]);
  }
  return Math.min(n, LIST_LIMIT_MAX);
}

export function strQ(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

export function dateQ(v: unknown, field: string): Date | undefined {
  if (v === undefined || v === '') return undefined;
  const d = typeof v === 'string' ? new Date(v) : null;
  if (!d || Number.isNaN(d.getTime())) {
    throw validationError([{ field, code: 'format' }]);
  }
  return d;
}

/** Страница: запрошено `limit + 1`, лишняя строка — признак продолжения. */
export function pageOf<T extends { id: string }>(
  rows: T[],
  limit: number,
): ListPage<T> {
  const page = rows.slice(0, limit);
  return {
    items: page,
    nextBefore: rows.length > limit ? page[page.length - 1].id : null,
  };
}

/**
 * Ответ списка: JSON-конверт или CSV (с аудитом выгрузки отдельной
 * короткой транзакцией — `recordRead`).
 */
export async function respondList<T extends { id: string }>(
  res: Response,
  ops: PubOperations,
  ctx: PubRequestCtx,
  name: string,
  format: 'json' | 'csv',
  rows: T[],
  limit: number,
  columns: readonly string[],
): Promise<void> {
  if (format === 'csv') {
    const p = productOf(ctx);
    await ops.recordRead(ctx.m, ctx.access, p, 'product.read', {
      objectType: 'product',
      objectId: p.id,
      action: 'export',
      meta: { list: name, rows: rows.length },
    });
    sendCsv(
      res,
      name,
      toCsv(
        columns,
        rows.map((r) => jsonSafe(r) as Record<string, unknown>),
      ),
    );
    return;
  }
  sendEnvelope(res, pageOf(rows, limit));
}

export interface MutationSpec<T> {
  ops: PubOperations;
  ctx: PubRequestCtx;
  action: PubAction;
  scope: string;
  pathParams: Record<string, string>;
  raw: unknown;
  status: number;
  fn: (
    tx: PubTx,
    step: { actor: string; now: Date },
    body: Record<string, unknown>,
    opKey: string,
  ) => Promise<{ body: T; audit: AuditInput[] }>;
  /**
   * Ответ не хранится в ключе идемпотентности (только hash и `ref` с id):
   * повтор пересобирает его `rebuild` — для ответов со снимком имени
   * участника (Р-PUB-A1-13, S2-3).
   */
  noStore?: {
    refOf: (body: T) => OperationRef;
    rebuild: (tx: PubTx, ref: OperationRef | null) => Promise<T>;
  };
}

/** Мутация зоны: `runOperation` + HTTP-статус ответа. */
export async function mutate<T>(res: Response, s: MutationSpec<T>): Promise<T> {
  const body = bodyOf(s.raw);
  const r = await s.ops.run<T>(
    {
      m: s.ctx.m,
      access: s.ctx.access,
      product: productOf(s.ctx),
      action: s.action,
      opKey: body.opKey,
      scope: s.scope,
      pathParams: s.pathParams,
      body,
      ...(s.noStore
        ? {
            storeResponse: false,
            refOf: s.noStore.refOf,
            rebuild: s.noStore.rebuild,
          }
        : {}),
    },
    async (tx, step) => {
      const out = await s.fn(tx, step, body, body.opKey as string);
      return { status: s.status, body: out.body, audit: out.audit };
    },
  );
  res.status(r.status);
  return r.body;
}
