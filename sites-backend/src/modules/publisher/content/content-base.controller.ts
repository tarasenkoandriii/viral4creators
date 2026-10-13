/**
 * AI Publisher, P-B1 — общая обвязка контроллеров кабинета контента:
 * мутация через `runOperation` (`opKey` в теле, роль по матрице, аудит в
 * транзакции), продукт пути, роли участника для машин состояний.
 */
import type { Response } from 'express';
import { SitesDb } from '../../../prisma/sites-db.service';
import type { ProductCtx } from '../contracts/common';
import { PubError } from '../core/errors';
import {
  PubOperations,
  type OperationRef,
  type OperationStep,
} from '../core/operation';
import type { PubTx } from '../core/ports';
import type { PubRequestCtx } from '../core/pub-role.guard';
import type { PubAction, PubAccess } from '../core/roles';
import type { Actor } from '../core/state-machines';
import type { Body } from './input';
import type { OpOut } from './sources.service';

export function actorsOf(access: PubAccess): Actor[] {
  return [...access.roles, ...(access.admin ? (['admin'] as const) : [])];
}

export function productOf(ctx: PubRequestCtx): ProductCtx {
  if (!ctx.product) throw new PubError('PUB_NOT_FOUND');
  return ctx.product;
}

export interface RunOpts<T> {
  status?: number;
  /** Ответ с ключами ПД (`task`) — в ключе только hash и `ref` (Р-PUB-A1-13). */
  noStore?: {
    refOf: (body: T) => OperationRef;
    rebuild: (tx: PubTx, ref: OperationRef | null) => Promise<T>;
  };
}

export abstract class ContentControllerBase {
  constructor(
    protected readonly db: SitesDb,
    protected readonly ops: PubOperations,
  ) {}

  protected tenant(ctx: PubRequestCtx): PubTx {
    return this.db.forAccount(ctx.m.accountId) as unknown as PubTx;
  }

  protected async run<T>(
    ctx: PubRequestCtx,
    res: Response,
    action: PubAction,
    scope: string,
    pathParams: Record<string, string>,
    body: Body,
    fn: (tx: PubTx, step: OperationStep) => Promise<OpOut<T>>,
    opts: RunOpts<T> = {},
  ): Promise<T> {
    const r = await this.ops.run<T>(
      {
        m: ctx.m,
        access: ctx.access,
        product: productOf(ctx),
        action,
        opKey: body.opKey,
        scope,
        pathParams,
        body,
        ...(opts.noStore
          ? {
              storeResponse: false,
              refOf: opts.noStore.refOf,
              rebuild: opts.noStore.rebuild,
            }
          : {}),
      },
      async (tx, step) => {
        const out = await fn(tx, step);
        return { status: opts.status ?? 200, body: out.body, audit: out.audit };
      },
    );
    res.status(r.status);
    return r.body;
  }
}
