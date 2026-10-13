/**
 * AI Publisher — AI-задачи: лимит генераций и разрешение третьей (P-B2,
 * проектный документ §6.7, §12.5; матрица §4.2 «AI: разрешить генерацию
 * сверх двух» — ED, PO).
 *
 * `extra`: только когда лимит задачи исчерпан; согласование
 * `pub_approvals(type=ai_extra_generation, objectType=ai_task)` с причиной
 * (этот сервис пишет ТОЛЬКО этот тип, §6.8) и `extraAllowance + 1`
 * (триггер `pub_ai_tasks_guard` требует такое согласование); только при
 * остатке AI-бюджета месяца (§12.5). Генерацию это не запускает — человек
 * повторяет AI-операцию. Задача `needs_human` (две неудачи) решением
 * редактора возвращается в `open` (машина `ai_task`, `reopen`, аудит S3-5);
 * принятая `done` — нет (`PUB_TRANSITION_INVALID`).
 *
 * `accept` / `AiTasksPort.acceptCall` (интеграция Z-1, Р-PUB-Z1-4): результат
 * вызова принят человеком в запись (§7.5 `open → done`, машина `ai_task`
 * — ED, PO, OP). Маршрут `POST …/ai/tasks/:id/accept {opKey, callId}`
 * (действие матрицы `ai.generate`); P-B1 вызывает порт в транзакции своей
 * мутации с `aiCallId`. Принять можно только вызов `ok` (аудит S3-8:
 * отказ, ошибка схемы, `running` — 422 `ai_call`). Задача не в `open`
 * (уже принята, `needs_human`) через порт не меняется, через маршрут —
 * `PUB_TRANSITION_INVALID`.
 */
import { Injectable } from '@nestjs/common';
import type { AiTaskView } from '../contracts/ai-api';
import type { GeneratorId } from '../contracts/ai';
import type { AiTaskStatus } from '../contracts/states';
import { PubError, assertNoIssues, validationError } from '../core/errors';
import { kyivMonthOf } from '../core/kyiv-time';
import { piiIssues } from '../core/pii-guard';
import type { AiTasksPort, AuditInput, ProductRef, PubTx } from '../core/ports';
import {
  AI_TASK_MACHINE,
  assertTransition,
  type Actor,
} from '../core/state-machines';
import { aiMonthRemaining } from './ai-budget';
import { BASE_GENERATIONS, aiRowId } from './gateway-core';

type TaskRow = NonNullable<
  Awaited<ReturnType<PubTx['pubAiTask']['findFirst']>>
>;

export function taskView(r: TaskRow): AiTaskView {
  return {
    id: r.id,
    generator: r.generator as GeneratorId,
    objectType: r.objectType,
    objectId: r.objectId,
    generationsUsed: r.generationsUsed,
    extraAllowance: r.extraAllowance,
    remaining: Math.max(
      0,
      BASE_GENERATIONS + r.extraAllowance - r.generationsUsed,
    ),
    status: r.status as AiTaskStatus,
    extraApprovalId: r.extraApprovalId,
    revision: r.revision,
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** Снимок имени без контактов (как гранты ядра). */
export const memberSnapshot = (memberId: string): string =>
  `Учасник …${memberId.slice(-6)}`;

export function reasonIssues(reason: unknown, field = 'reason') {
  if (
    typeof reason !== 'string' ||
    reason.trim().length < 3 ||
    reason.length > 2000
  ) {
    return [{ field, code: reason === undefined ? 'required' : 'length' }];
  }
  return piiIssues({ [field]: reason });
}

@Injectable()
export class AiTasksService implements AiTasksPort {
  /** Строка задачи под блокировкой (переходы и extra сериализуются). */
  private async locked(
    tx: PubTx,
    product: ProductRef,
    taskId: string,
  ): Promise<TaskRow> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "sites"."pub_ai_tasks"
       WHERE "id" = ${taskId} AND "productId" = ${product.id} AND "accountId" = ${product.accountId}
         FOR UPDATE`;
    const task = rows[0]
      ? await tx.pubAiTask.findFirst({ where: { id: taskId } })
      : null;
    if (!task) throw new PubError('PUB_NOT_FOUND');
    return task;
  }

  private async markDone(tx: PubTx, task: TaskRow): Promise<void> {
    const n = await tx.pubAiTask.updateMany({
      where: { id: task.id, status: 'open' },
      data: { status: 'done', revision: { increment: 1 } },
    });
    if (n.count !== 1) throw new PubError('PUB_CONFLICT');
  }

  /** Порт для P-B1: задача принятого вызова `open → done` (иначе — без изменений). */
  async acceptCall(
    tx: PubTx,
    product: ProductRef,
    callId: string,
    input: { actors: Actor[] },
  ): Promise<{ taskId: string; fromStatus: string; accepted: boolean }> {
    const call = await tx.pubAiCall.findFirst({
      where: { id: callId, productId: product.id },
      select: { taskId: true, status: true },
    });
    if (!call) throw new PubError('PUB_NOT_FOUND', { field: 'aiCallId' });
    if (call.status !== 'ok') {
      throw validationError([{ field: 'aiCallId', code: 'ai_call' }]);
    }
    const task = await this.locked(tx, product, call.taskId);
    if (task.status !== 'open') {
      return { taskId: task.id, fromStatus: task.status, accepted: false };
    }
    assertTransition(AI_TASK_MACHINE, 'open', 'done', {
      actors: input.actors,
    });
    await this.markDone(tx, task);
    return { taskId: task.id, fromStatus: 'open', accepted: true };
  }

  /** Маршрут `accept`: результат `callId` этой задачи принят человеком. */
  async accept(
    tx: PubTx,
    product: ProductRef,
    taskId: string,
    input: { callId: unknown; actors: Actor[] },
  ): Promise<{ view: AiTaskView; audit: AuditInput[] }> {
    if (typeof input.callId !== 'string' || !input.callId) {
      throw validationError([{ field: 'callId', code: 'required' }]);
    }
    const task = await this.locked(tx, product, taskId);
    const call = await tx.pubAiCall.findFirst({
      where: { id: input.callId, productId: product.id, taskId: task.id },
      select: { status: true },
    });
    if (!call || call.status !== 'ok') {
      throw validationError([{ field: 'callId', code: 'ai_call' }]);
    }
    assertTransition(AI_TASK_MACHINE, task.status as AiTaskStatus, 'done', {
      actors: input.actors,
    });
    await this.markDone(tx, task);
    const after = await tx.pubAiTask.findFirst({ where: { id: task.id } });
    return {
      view: taskView(after!),
      audit: [
        {
          objectType: 'ai_task',
          objectId: task.id,
          action: 'transition',
          fromStatus: task.status,
          toStatus: 'done',
          meta: { aiCallId: input.callId },
        },
      ],
    };
  }

  async get(
    db: Pick<PubTx, 'pubAiTask'>,
    productId: string,
    taskId: string,
  ): Promise<AiTaskView> {
    const r = await db.pubAiTask.findFirst({
      where: { id: taskId, productId },
    });
    if (!r) throw new PubError('PUB_NOT_FOUND');
    return taskView(r);
  }

  async extra(
    tx: PubTx,
    product: ProductRef,
    taskId: string,
    input: {
      reason: unknown;
      memberId: string;
      actor: string;
      now: Date;
      actors?: Actor[];
    },
  ): Promise<{ view: AiTaskView; audit: AuditInput[] }> {
    assertNoIssues(reasonIssues(input.reason));
    const task = await this.locked(tx, product, taskId);
    const reopen = task.status === 'needs_human';
    if (reopen) {
      // Машина `ai_task`: `needs_human → open` — ED, PO по согласованию.
      assertTransition(AI_TASK_MACHINE, 'needs_human', 'open', {
        actors: input.actors,
      });
    } else if (task.status !== 'open') {
      throw new PubError('PUB_TRANSITION_INVALID', {
        machine: 'ai_task',
        from: task.status,
        to: 'open',
        allowed: [],
        taskId: task.id,
      });
    } else if (task.generationsUsed < BASE_GENERATIONS + task.extraAllowance) {
      throw validationError([{ field: 'taskId', code: 'limit_not_reached' }]);
    }
    const remaining = await aiMonthRemaining(
      tx,
      product.id,
      kyivMonthOf(input.now),
    );
    if (remaining === null || remaining <= 0n) {
      throw new PubError('PUB_AI_BUDGET', {
        reason: remaining === null ? 'month_not_open' : 'cap_exhausted',
      });
    }
    const approvalId = aiRowId('apx');
    await tx.pubApproval.create({
      data: {
        id: approvalId,
        accountId: product.accountId,
        productId: product.id,
        type: 'ai_extra_generation',
        objectType: 'ai_task',
        objectId: task.id,
        approverMemberId: input.memberId,
        approverDisplayName: memberSnapshot(input.memberId),
        decidedAt: input.now,
        status: 'active',
        selfReview: false,
        reason: (input.reason as string).trim(),
        createdBy: input.actor,
      },
    });
    const allowance = task.extraAllowance + 1;
    const n = await tx.pubAiTask.updateMany({
      where: { id: task.id, status: task.status, revision: task.revision },
      data: {
        extraAllowance: allowance,
        extraApprovalId: approvalId,
        revision: { increment: 1 },
        ...(reopen ? { status: 'open' } : {}),
      },
    });
    if (n.count !== 1) throw new PubError('PUB_CONFLICT');
    const after = await tx.pubAiTask.findFirst({ where: { id: task.id } });
    return {
      view: taskView(after!),
      audit: [
        {
          objectType: 'ai_task',
          objectId: task.id,
          action: 'approve',
          reason: (input.reason as string).trim(),
          meta: { approvalId, extraAllowance: allowance },
        },
        ...(reopen
          ? [
              {
                objectType: 'ai_task' as const,
                objectId: task.id,
                action: 'transition' as const,
                fromStatus: 'needs_human',
                toStatus: 'open',
                meta: { approvalId },
              },
            ]
          : []),
      ],
    };
  }
}
