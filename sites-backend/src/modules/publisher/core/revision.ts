/**
 * AI Publisher — оптимистичные ревизии «голов» (P-A1, проектный документ
 * §1 п.5, §8; механизм AT-CORE-10). Запись с устаревшей ревизией — 409
 * `PUB_CONFLICT {currentRevision}`, а не молчаливая перезапись.
 *
 * CAS одним оператором: `UPDATE … WHERE id AND revision = expected` (через
 * `updateMany`) — 0 строк → перечитать: строки нет (или она чужого
 * кабинета — тенант) → 404 `PUB_NOT_FOUND`, иначе 409 с текущей ревизией.
 * В READ COMMITTED второй параллельный CAS ждёт блокировку строки и
 * перепроверяет условие на новой версии — проходит ровно один.
 */
import type { FieldIssue } from '../contracts/errors';
import { PubError, validationError } from './errors';

/** Минимум делегата Prisma для CAS (`tx.pubProduct`, `tx.pubParameter`, …). */
export interface CasDelegate {
  updateMany(args: {
    where: { id: string; revision: number };
    data: Record<string, unknown>;
  }): PromiseLike<{ count: number }>;
  findFirst(args: {
    where: { id: string };
    select: { revision: true };
  }): PromiseLike<{ revision: number } | null>;
}

/** `expectedRevision` из тела: целое ≥ 1. */
export function parseExpectedRevision(
  v: unknown,
  field = 'expectedRevision',
): number {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 1) return v;
  const issue: FieldIssue = {
    field,
    code: v === undefined ? 'required' : 'type',
  };
  throw validationError([issue]);
}

/**
 * Условное обновление по ревизии; ревизия растёт на 1. Возвращает новую
 * ревизию. `data` не должен трогать `revision` сам.
 */
export async function casUpdate(
  delegate: CasDelegate,
  id: string,
  expectedRevision: number,
  data: Record<string, unknown>,
): Promise<number> {
  if ('revision' in data) {
    throw new Error('casUpdate: ревизию меняет только CAS');
  }
  const res = await delegate.updateMany({
    where: { id, revision: expectedRevision },
    data: { ...data, revision: { increment: 1 } },
  });
  if (res.count === 1) return expectedRevision + 1;
  await throwConflictOrNotFound(delegate, id);
  return expectedRevision; // недостижимо
}

export async function throwConflictOrNotFound(
  delegate: Pick<CasDelegate, 'findFirst'>,
  id: string,
): Promise<never> {
  const row = await delegate.findFirst({
    where: { id },
    select: { revision: true },
  });
  if (!row) throw new PubError('PUB_NOT_FOUND');
  throw new PubError('PUB_CONFLICT', { currentRevision: row.revision });
}

/** Проверка ревизии прочитанной строки (когда запись идёт не через CAS). */
export function assertRevision(current: number, expected: number): void {
  if (current !== expected) {
    throw new PubError('PUB_CONFLICT', { currentRevision: current });
  }
}
