/**
 * AI Publisher — шаблон мутирующей операции `runOperation` (P-A1,
 * проектный документ §8.1; принципы §1 п.4–5).
 *
 * Порядок:
 *  1. роль по матрице §4.2 (`PUB_ROLE_REQUIRED`), формат `opKey`;
 *  2. `BEGIN ISOLATION LEVEL READ COMMITTED` (maxWait 5 с, timeout 10 с);
 *  3. `INSERT pub_idempotency_keys … ON CONFLICT (accountId, opKey) DO
 *     NOTHING RETURNING` — ключ уровня кабинета (создание продукта тоже
 *     идемпотентно). Существующий ключ: тот же `requestHash` (sha256
 *     `{scope, pathParams, body}`) → прежний ответ без выполнения; другой →
 *     409 `PUB_IDEMPOTENCY_REUSED`;
 *  4. `fn(tx)` — CAS, переходы, гейты; все чтения — через `tx`;
 *  5. записи аудита в той же транзакции;
 *  6. ответ — в ключ (или только статус и hash при `storeResponse:false`;
 *     повтор тогда пересобирает ответ `rebuild`); ключи ПД в ответе —
 *     отказ (ошибка кода, транзакция откатывается; то же — триггер);
 *  7. `COMMIT`.
 * Ошибка внутри — откат, ключ не сохраняется: повтор выполнит операцию
 * заново. Prisma P2028/P2034 (таймаут ожидания, конфликт) → 503
 * `PUB_BUSY` (повторить с тем же `opKey`). Отказ триггера (23514) →
 * `PUB_VALIDATION {fields:[{field:'<таблица>.<поле>', code:'constraint'}]}`,
 * гонка уникальности (23505) → `PUB_CONFLICT`.
 *
 * Сеть (AI, HTTP) внутри `fn` запрещена. ИСКЛЮЧЕНИЯ ПО АУДИТУ (аудит
 * P1-3): ответы с расшифрованными или приватными данными через
 * runOperation не идут — раскрытие контакта и заметок оформлено ЧТЕНИЕМ
 * (`GET` без `opKey`, без ключа идемпотентности, без хранения ответа), а
 * запись аудита `reveal_contact` — отдельной короткой транзакцией
 * `recordRead` ниже. Чтения не принимают `opKey`.
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { SitesDb } from '../../../prisma/sites-db.service';
import type { AccountMembership } from '../../site-core/account/roles';
import { OP_KEY_RE, memberActor, type ProductCtx } from '../contracts/common';
import { AuditService } from './audit';
import { canonicalJson, requestHashOf, sha256Hex } from './content-hash';
import { PubError, validationError } from './errors';
import { addKyivCalendarDays } from './kyiv-time';
import { jsonSafe } from './money';
import { RESPONSE_FORBIDDEN_KEYS, forbiddenKeysIn } from './pii-guard';
import type { AuditInput, PubTx } from './ports';
import { can, deniedForKind, type PubAccess, type PubAction } from './roles';

export const OPERATION_TX_OPTIONS = {
  isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
  maxWait: 5000,
  timeout: 10000,
} as const;

/** Ключ идемпотентности живёт 30 календарных дней (чистка — publisher-daily). */
export const IDEMPOTENCY_TTL_DAYS = 30;

export interface OperationCtx<T> {
  m: AccountMembership;
  access: PubAccess;
  product: ProductCtx | null;
  siteId?: string;
  action: PubAction;
  opKey: unknown;
  scope: string;
  pathParams: Record<string, string>;
  body: unknown;
  /**
   * false — в ключе только статус, hash ответа и `ref` (id объектов, без
   * текста); повтор пересобирает ответ `rebuild(tx, ref)` из базы. Нужен,
   * когда ответ несёт ключи из списка ПД триггера (`name` продукта, `name`
   * события в `event_map`) или приватный текст.
   */
  storeResponse?: boolean;
  refOf?: (body: T) => OperationRef;
  rebuild?: (tx: PubTx, ref: OperationRef | null) => Promise<T>;
}

/** Ссылка на объекты ответа для `rebuild` — только id и числа. */
export type OperationRef = Record<string, string | number | null>;

export interface OperationStep {
  actor: string;
  now: Date;
}

export interface OperationOutput<T> {
  status: number;
  body: T;
  audit: AuditInput[];
}

export interface OperationResult<T> {
  status: number;
  /** JSON-безопасный ответ (bigint → строка, Date → ISO). */
  body: T;
  replayed: boolean;
}

interface KeyRow {
  requestHash: string;
  responseStatus: number | null;
  responseBody: unknown;
}

/** SQLSTATE драйвера (`pg`) под обёртками Prisma 7 с адаптером. */
export function pgCodeOf(e: unknown): string | undefined {
  const seen = new Set<unknown>();
  const walk = (x: unknown, depth: number): string | undefined => {
    if (!x || typeof x !== 'object' || seen.has(x) || depth > 6)
      return undefined;
    seen.add(x);
    const o = x as Record<string, unknown>;
    for (const k of ['originalCode', 'code']) {
      const v = o[k];
      if (
        typeof v === 'string' &&
        /^[0-9A-Z]{5}$/.test(v) &&
        !/^P\d{4}$/.test(v)
      ) {
        return v;
      }
    }
    for (const k of ['cause', 'meta', 'driverAdapterError', 'error']) {
      const r = walk(o[k], depth + 1);
      if (r) return r;
    }
    return undefined;
  };
  return walk(e, 0);
}

function prismaCodeOf(e: unknown): string | undefined {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^P\d{4}$/.test(code) ? code : undefined;
}

function messageOf(e: unknown): string {
  const seen = new Set<unknown>();
  const parts: string[] = [];
  const walk = (x: unknown, depth: number): void => {
    if (!x || typeof x !== 'object' || seen.has(x) || depth > 6) return;
    seen.add(x);
    const o = x as Record<string, unknown>;
    for (const k of ['message', 'originalMessage']) {
      if (typeof o[k] === 'string') parts.push(o[k] as string);
    }
    for (const k of ['cause', 'meta', 'driverAdapterError'])
      walk(o[k], depth + 1);
  };
  walk(e, 0);
  return parts.join(' | ');
}

/**
 * Ошибка базы → код Publisher (или null — не наша, пробросить как есть).
 */
export function mapDbError(e: unknown): PubError | null {
  if (e instanceof PubError) return e;
  const prisma = prismaCodeOf(e);
  if (prisma === 'P2028' || prisma === 'P2034') return new PubError('PUB_BUSY');
  const pg = pgCodeOf(e);
  if (pg === '40001' || pg === '40P01' || pg === '55P03')
    return new PubError('PUB_BUSY');
  if (pg === '23514') {
    const m = /(pub_[a-z_]+)(\.[A-Za-z_]+)?(\/[A-Za-z_]+)?:/.exec(messageOf(e));
    const field = m ? `${m[1]}${m[2] ?? ''}` : 'constraint';
    return new PubError('PUB_VALIDATION', {
      fields: [{ field, code: 'constraint' }],
    });
  }
  if (pg === '23505' || prisma === 'P2002') {
    return new PubError('PUB_CONFLICT', { reason: 'unique' });
  }
  if (pg === '23503' || prisma === 'P2003') {
    return new PubError('PUB_NOT_FOUND', { reason: 'reference' });
  }
  return null;
}

@Injectable()
export class PubOperations {
  constructor(
    private readonly db: SitesDb,
    private readonly audit: AuditService,
  ) {}

  async run<T>(
    ctx: OperationCtx<T>,
    fn: (tx: PubTx, step: OperationStep) => Promise<OperationOutput<T>>,
  ): Promise<OperationResult<T>> {
    if (!can(ctx.access, ctx.action)) {
      throw new PubError('PUB_ROLE_REQUIRED', { action: ctx.action });
    }
    if (deniedForKind(ctx.action, ctx.product?.kind)) {
      throw new PubError('PUB_ROLE_REQUIRED', {
        action: ctx.action,
        reason: 'product_kind',
        kind: ctx.product?.kind,
      });
    }
    if (typeof ctx.opKey !== 'string' || !OP_KEY_RE.test(ctx.opKey)) {
      throw validationError([
        {
          field: 'opKey',
          code: ctx.opKey === undefined ? 'required' : 'format',
        },
      ]);
    }
    if (ctx.storeResponse === false && !ctx.rebuild) {
      throw new Error('runOperation: storeResponse:false требует rebuild');
    }
    const opKey = ctx.opKey;
    const accountId = ctx.m.accountId;
    const actor = memberActor(ctx.m.memberId);
    const requestHash = requestHashOf(
      ctx.scope,
      ctx.pathParams,
      ctx.body,
      actor,
    );
    try {
      return await this.db.forAccount(accountId).$transaction(async (tx) => {
        const now = new Date();
        const inserted = await tx.$queryRaw<Array<{ id: string }>>`
          INSERT INTO "sites"."pub_idempotency_keys"
            ("id", "accountId", "productId", "siteId", "opKey", "scope", "requestHash",
             "expiresAt", "createdBy")
          VALUES (${`ik_${randomUUID()}`}, ${accountId}, ${ctx.product?.id ?? null},
                  ${ctx.siteId ?? ctx.product?.siteId ?? null}, ${opKey}, ${ctx.scope},
                  ${requestHash}, ${addKyivCalendarDays(now, IDEMPOTENCY_TTL_DAYS)}, ${actor})
          ON CONFLICT ("accountId", "opKey") DO NOTHING
          RETURNING "id"`;
        if (inserted.length === 0) {
          return this.replay(tx, ctx, accountId, opKey, requestHash);
        }
        const out = await fn(tx, { actor, now });
        for (const a of out.audit) {
          const productId = a.productId ?? ctx.product?.id;
          if (!productId) {
            throw new Error(`runOperation(${ctx.scope}): аудит без продукта`);
          }
          await this.audit.write(tx, {
            ...a,
            accountId,
            productId,
            actor: a.actor ?? actor,
            occurredAt: a.occurredAt ?? now,
          });
        }
        const body = jsonSafe(out.body) as T;
        const stored =
          ctx.storeResponse === false
            ? {
                responseHash: sha256Hex(canonicalJson(body ?? null)),
                ...(ctx.refOf ? { ref: ctx.refOf(out.body) } : {}),
              }
            : (body ?? null);
        const banned = forbiddenKeysIn(stored, RESPONSE_FORBIDDEN_KEYS);
        if (banned.length) {
          throw new Error(
            `runOperation(${ctx.scope}): в ответе ключи персональных данных (${banned.join(', ')}) — такие ответы оформляются чтением`,
          );
        }
        await tx.$executeRaw`
          UPDATE "sites"."pub_idempotency_keys"
             SET "responseStatus" = ${out.status},
                 "responseBody" = ${stored === null ? null : JSON.stringify(stored)}::jsonb
           WHERE "accountId" = ${accountId} AND "opKey" = ${opKey}`;
        return { status: out.status, body, replayed: false };
      }, OPERATION_TX_OPTIONS);
    } catch (e) {
      throw mapDbError(e) ?? e;
    }
  }

  private async replay<T>(
    tx: PubTx,
    ctx: OperationCtx<T>,
    accountId: string,
    opKey: string,
    requestHash: string,
  ): Promise<OperationResult<T>> {
    const rows = await tx.$queryRaw<KeyRow[]>`
      SELECT "requestHash", "responseStatus", "responseBody"
        FROM "sites"."pub_idempotency_keys"
       WHERE "accountId" = ${accountId} AND "opKey" = ${opKey}`;
    const row = rows[0];
    if (!row) throw new PubError('PUB_BUSY');
    if (row.requestHash !== requestHash) {
      throw new PubError('PUB_IDEMPOTENCY_REUSED');
    }
    // Ключ без ответа виден только незавершённой чужой транзакции — её
    // результат ещё неизвестен: «занято, повторите».
    if (row.responseStatus === null) throw new PubError('PUB_BUSY');
    if (ctx.storeResponse === false) {
      const stored = (row.responseBody ?? {}) as { ref?: OperationRef };
      const rebuild = ctx.rebuild as NonNullable<OperationCtx<T>['rebuild']>;
      const body = jsonSafe(await rebuild(tx, stored.ref ?? null)) as T;
      return { status: row.responseStatus, body, replayed: true };
    }
    return {
      status: row.responseStatus,
      body: row.responseBody as T,
      replayed: true,
    };
  }

  /**
   * Аудит ЧТЕНИЯ приватных данных (раскрытие контакта, заметок — §11.3,
   * аудит P1-3): отдельная короткая транзакция, без ключа идемпотентности и
   * без хранения ответа. Вызывается ДО отдачи данных: нет записи — нет
   * раскрытия.
   */
  async recordRead(
    m: AccountMembership,
    access: PubAccess,
    product: ProductCtx,
    action: PubAction,
    audit: AuditInput,
  ): Promise<void> {
    if (!can(access, action)) {
      throw new PubError('PUB_ROLE_REQUIRED', { action });
    }
    // Р-PUB-Z2-2: вторая линия к гварду (раскрытие в `restored`).
    if (deniedForKind(action, product.kind)) {
      throw new PubError('PUB_ROLE_REQUIRED', {
        action,
        reason: 'product_kind',
        kind: product.kind,
      });
    }
    try {
      await this.db.forAccount(m.accountId).$transaction(async (tx) => {
        await this.audit.write(tx, {
          ...audit,
          accountId: m.accountId,
          productId: product.id,
          actor: audit.actor ?? memberActor(m.memberId),
        });
      }, OPERATION_TX_OPTIONS);
    } catch (e) {
      throw mapDbError(e) ?? e;
    }
  }
}
