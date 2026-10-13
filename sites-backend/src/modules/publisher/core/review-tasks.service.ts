/**
 * AI Publisher — задачи проверки (P-A1, проектный документ §6.2
 * `pub_review_tasks`, §7.5; F02/F04/F06, AT-CORE-21). Другие пакеты
 * открывают задачи через `ReviewPort.open` в транзакции своей операции;
 * повтор того же события (`objectType, objectId, reason, triggerRef`) задач
 * не плодит (уникальный ключ + `ON CONFLICT DO NOTHING`).
 */
import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { ListPage } from '../contracts/common';
import type { ReviewTaskView } from '../contracts/core-api';
import { LIST_LIMIT_DEFAULT, LIST_LIMIT_MAX } from '../contracts/common';
import {
  OBJECT_TYPES,
  REVIEW_REASONS,
  REVIEW_SEVERITIES,
  isOneOf,
  type ReviewReason,
  type ReviewSeverity,
  type ReviewStatus,
} from '../contracts/states';
import { AuditService } from './audit';
import { PubError, assertNoIssues } from './errors';
import { piiIssues } from './pii-guard';
import type { ProductRef, PubTx, ReviewItem, ReviewPort } from './ports';
import { casUpdate } from './revision';
import {
  REVIEW_TASK_MACHINE,
  assertTransition,
  type Actor,
} from './state-machines';

type TaskRow = {
  id: string;
  objectType: string;
  objectId: string;
  reason: string;
  triggerRef: string;
  severity: string;
  status: string;
  assigneeMemberId: string | null;
  dueAt: Date | null;
  resolution: string | null;
  resolvedBy: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
  revision: number;
};

export function reviewTaskView(r: TaskRow): ReviewTaskView {
  return {
    id: r.id,
    objectType: r.objectType,
    objectId: r.objectId,
    reason: r.reason as ReviewReason,
    triggerRef: r.triggerRef,
    severity: r.severity as ReviewSeverity,
    status: r.status as ReviewStatus,
    assigneeMemberId: r.assigneeMemberId,
    dueAt: r.dueAt?.toISOString() ?? null,
    resolution: r.resolution,
    resolvedBy: r.resolvedBy,
    resolvedAt: r.resolvedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    revision: r.revision,
  };
}

@Injectable()
export class ReviewTasksService implements ReviewPort {
  constructor(private readonly audit: AuditService) {}

  async open(
    tx: PubTx,
    product: ProductRef,
    items: ReviewItem[],
    opts: { actor?: string } = {},
  ): Promise<number> {
    const actor = opts.actor ?? 'system:review';
    let created = 0;
    for (const it of items) {
      if (
        !isOneOf(OBJECT_TYPES, it.objectType) ||
        !isOneOf(REVIEW_REASONS, it.reason)
      ) {
        throw new Error(
          `review: objectType/reason вне списка (${it.objectType}/${it.reason})`,
        );
      }
      if (!isOneOf(REVIEW_SEVERITIES, it.severity)) {
        throw new Error(`review: severity вне списка (${it.severity})`);
      }
      const id = `rt_${randomUUID()}`;
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO "sites"."pub_review_tasks"
          ("id", "accountId", "productId", "objectType", "objectId", "reason", "triggerRef",
           "severity", "assigneeMemberId", "dueAt", "createdBy")
        VALUES (${id}, ${product.accountId}, ${product.id}, ${it.objectType}, ${it.objectId},
                ${it.reason}, ${it.triggerRef}, ${it.severity}, ${it.assigneeMemberId ?? null},
                ${it.dueAt ?? null}, ${actor})
        ON CONFLICT ("productId", "objectType", "objectId", "reason", "triggerRef") DO NOTHING
        RETURNING "id"`;
      if (rows.length === 0) continue;
      created++;
      await this.audit.write(tx, {
        accountId: product.accountId,
        productId: product.id,
        actor,
        objectType: 'review_task',
        objectId: id,
        action: 'create',
        toStatus: 'open',
        meta: {
          objectType: it.objectType,
          objectId: it.objectId,
          reason: it.reason,
          severity: it.severity,
        },
      });
    }
    return created;
  }

  async list(
    db: PubTx,
    productId: string,
    f: {
      status?: string;
      assignee?: string;
      reason?: string;
      reasons?: readonly string[];
      before?: string;
      limit?: number;
    },
  ): Promise<ListPage<ReviewTaskView>> {
    const limit = Math.min(
      Math.max(f.limit ?? LIST_LIMIT_DEFAULT, 1),
      LIST_LIMIT_MAX,
    );
    const cursor = f.before
      ? await db.pubReviewTask.findFirst({
          where: { id: f.before, productId },
          select: { id: true, createdAt: true },
        })
      : null;
    const rows = await db.pubReviewTask.findMany({
      where: {
        productId,
        ...(f.status ? { status: f.status } : {}),
        ...(f.assignee ? { assigneeMemberId: f.assignee } : {}),
        ...(f.reason ? { reason: f.reason } : {}),
        ...(f.reasons && !f.reason ? { reason: { in: [...f.reasons] } } : {}),
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    return {
      items: page.map(reviewTaskView),
      nextBefore: rows.length > limit ? page[page.length - 1].id : null,
    };
  }

  async get(db: PubTx, productId: string, id: string): Promise<TaskRow> {
    const row = await db.pubReviewTask.findFirst({ where: { id, productId } });
    if (!row) throw new PubError('PUB_NOT_FOUND');
    return row;
  }

  /** Решение задачи (`open → resolved|dismissed`): текст без контактов. */
  async resolve(
    tx: PubTx,
    product: ProductRef,
    id: string,
    input: {
      status: 'resolved' | 'dismissed';
      resolution: string;
      expectedRevision: number;
      actor: string;
      actors: Actor[];
      now: Date;
    },
  ): Promise<ReviewTaskView> {
    assertNoIssues(piiIssues({ resolution: input.resolution }));
    const row = await this.get(tx, product.id, id);
    assertTransition(
      REVIEW_TASK_MACHINE,
      row.status as ReviewStatus,
      input.status,
      {
        actors: input.actors,
      },
    );
    await casUpdate(tx.pubReviewTask, id, input.expectedRevision, {
      status: input.status,
      resolution: input.resolution,
      resolvedBy: input.actor,
      resolvedAt: input.now,
    });
    return reviewTaskView(await this.get(tx, product.id, id));
  }

  async assign(
    tx: PubTx,
    product: ProductRef,
    id: string,
    input: { assigneeMemberId: string | null; expectedRevision: number },
  ): Promise<ReviewTaskView> {
    const row = await this.get(tx, product.id, id);
    if (row.status !== 'open') {
      throw new PubError('PUB_TRANSITION_INVALID', {
        machine: 'review_task',
        from: row.status,
        to: row.status,
        allowed: [],
      });
    }
    await casUpdate(tx.pubReviewTask, id, input.expectedRevision, {
      assigneeMemberId: input.assigneeMemberId,
    });
    return reviewTaskView(await this.get(tx, product.id, id));
  }
}
