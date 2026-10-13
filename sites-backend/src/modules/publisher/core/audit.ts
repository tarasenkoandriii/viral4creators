/**
 * AI Publisher — журнал аудита (P-A1, проектный документ §6.2; ТЗ §9
 * AuditEvent). Пишет ТОЛЬКО этот модуль и только в транзакции операции:
 * запись аудита и изменение атомарны. Таблица append-only (триггер).
 *
 * Без ПД: `reason` и строковые значения `meta` (кроме ключей-
 * идентификаторов `…Id/…Hash/…Ref`) проходят `pii-guard` (контакт →
 * `PUB_VALIDATION {field:'reason'|'meta.<путь>', code:'pii'}`, аудит P3-4);
 * в `meta` запрещены ключи ПД по правилу `pub_json_has_keys` (список
 * `contact, email, phone, name, task, *Enc, token, secret`, ключи с
 * `email/phone/password/secret` внутри, `contact…` кроме
 * `contactMethod/contactDueAt`, имена человека) на любой глубине (то же —
 * триггер `pub_audit_meta_guard`; здесь — раньше и понятнее), `meta` ≤ 8 КБ.
 */
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { ListPage } from '../contracts/common';
import type { AuditEventView } from '../contracts/core-api';
import { LIST_LIMIT_DEFAULT, LIST_LIMIT_MAX } from '../contracts/common';
import {
  AUDIT_ACTIONS,
  OBJECT_TYPES,
  isOneOf,
  type AuditAction,
  type ObjectType,
} from '../contracts/states';
import { assertNoIssues } from './errors';
import { jsonSafe } from './money';
import {
  AUDIT_META_FORBIDDEN_KEYS,
  contactValuesIn,
  forbiddenKeysIn,
  piiIssues,
} from './pii-guard';
import type { AuditInput, AuditPort, PubTx } from './ports';
import { jsonBytes } from './schema-lite';

export const AUDIT_META_MAX_BYTES = 8192;

/** Проверки записи до базы (ошибка кода — исключение, ПД в тексте — 400). */
export function checkAuditInput(e: AuditInput): void {
  if (!isOneOf(OBJECT_TYPES, e.objectType)) {
    throw new Error(`audit: objectType «${String(e.objectType)}» вне списка`);
  }
  if (!isOneOf(AUDIT_ACTIONS, e.action)) {
    throw new Error(`audit: action «${String(e.action)}» вне списка`);
  }
  assertNoIssues([
    ...piiIssues({ reason: e.reason ?? null }),
    ...(e.meta ? contactValuesIn(e.meta, 'meta') : []).map((field) => ({
      field,
      code: 'pii',
    })),
  ]);
  if (e.meta) {
    const keys = forbiddenKeysIn(e.meta, AUDIT_META_FORBIDDEN_KEYS);
    if (keys.length) {
      throw new Error(
        `audit: в meta ключи персональных данных/секретов (${keys.join(', ')})`,
      );
    }
    if (jsonBytes(jsonSafe(e.meta)) > AUDIT_META_MAX_BYTES) {
      throw new Error('audit: meta больше 8 КБ');
    }
  }
}

@Injectable()
export class AuditService implements AuditPort {
  async write(
    tx: PubTx,
    e: AuditInput & { accountId: string; productId: string; actor: string },
  ): Promise<void> {
    checkAuditInput(e);
    await tx.pubAuditEvent.create({
      data: {
        accountId: e.accountId,
        productId: e.productId,
        actor: e.actor,
        objectType: e.objectType,
        objectId: e.objectId,
        action: e.action,
        fromStatus: e.fromStatus ?? null,
        toStatus: e.toStatus ?? null,
        reason: e.reason ?? null,
        meta: e.meta ? (jsonSafe(e.meta) as Prisma.InputJsonObject) : undefined,
        occurredAt: e.occurredAt ?? new Date(),
        createdBy: e.actor,
      },
    });
  }

  /** Журнал продукта, новые первыми (`before` — id страницы). */
  async list(
    db: PubTx,
    productId: string,
    f: {
      objectType?: string;
      objectId?: string;
      before?: string;
      limit?: number;
    },
  ): Promise<ListPage<AuditEventView>> {
    const limit = Math.min(
      Math.max(f.limit ?? LIST_LIMIT_DEFAULT, 1),
      LIST_LIMIT_MAX,
    );
    let cursor: { occurredAt: Date; id: string } | null = null;
    if (f.before) {
      const row = await db.pubAuditEvent.findFirst({
        where: { id: f.before, productId },
        select: { id: true, occurredAt: true },
      });
      if (row) cursor = row;
    }
    const rows = await db.pubAuditEvent.findMany({
      where: {
        productId,
        ...(f.objectType ? { objectType: f.objectType } : {}),
        ...(f.objectId ? { objectId: f.objectId } : {}),
        ...(cursor
          ? {
              OR: [
                { occurredAt: { lt: cursor.occurredAt } },
                { occurredAt: cursor.occurredAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    return {
      items: page.map((r) => ({
        id: r.id,
        actor: r.actor,
        objectType: r.objectType as ObjectType,
        objectId: r.objectId,
        action: r.action as AuditAction,
        fromStatus: r.fromStatus,
        toStatus: r.toStatus,
        reason: r.reason,
        meta: r.meta,
        occurredAt: r.occurredAt.toISOString(),
      })),
      nextBefore: rows.length > limit ? page[page.length - 1].id : null,
    };
  }
}
