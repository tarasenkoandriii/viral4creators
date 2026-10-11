import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AccountMembership } from '../site-core/account/roles';
import { QaCatalogService } from './qa-catalog.service';
import { parseCaseInput, parseCaseKey, parseVersion } from './qa-case-input';
const invalid = () =>
  new BadRequestException({
    code: 'QA_RUN_INVALID',
    message: 'Проверьте название запуска, кейсы и результат.',
  });
const missing = () =>
  new NotFoundException({
    code: 'QA_RUN_NOT_FOUND',
    message: 'Запуск не найден.',
  });
const conflict = () =>
  new ConflictException({
    code: 'QA_RUN_CONFLICT',
    message: 'Запуск уже изменён. Обновите его перед записью результата.',
  });
const ID = /^[A-Za-z0-9_-]{1,64}$/;
export function parseRunInput(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw invalid();
  const b = input as Record<string, unknown>;
  if (
    Object.keys(b).some((k) => !['title', 'caseIds'].includes(k)) ||
    typeof b.title !== 'string' ||
    !b.title.trim() ||
    b.title.length > 200 ||
    !Array.isArray(b.caseIds) ||
    b.caseIds.length < 1 ||
    b.caseIds.length > 100 ||
    b.caseIds.some((id) => typeof id !== 'string' || !ID.test(id)) ||
    new Set(b.caseIds).size !== b.caseIds.length
  )
    throw invalid();
  return { title: b.title.trim(), caseIds: b.caseIds as string[] };
}
export function parseRunAttempt(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw invalid();
  const b = input as Record<string, unknown>;
  if (
    Object.keys(b).some(
      (k) => !['expectedRevision', 'caseKey', 'status', 'comment'].includes(k),
    ) ||
    typeof b.status !== 'string' ||
    !['passed', 'failed', 'blocked', 'skipped'].includes(b.status) ||
    typeof b.comment !== 'string' ||
    b.comment.length > 4000 ||
    (b.status !== 'passed' && !b.comment.trim())
  )
    throw invalid();
  return {
    expectedRevision: parseVersion(b.expectedRevision),
    caseKey: parseCaseKey(b.caseKey),
    status: b.status,
    comment: b.comment.trim(),
  };
}
export function runSummary(
  snapshot: unknown,
  attempts: Array<{ caseKey: string; status: string }>,
) {
  const cases = snapshot as Array<{ caseKey: string }>;
  const counts = { passed: 0, failed: 0, blocked: 0, skipped: 0, notRun: 0 };
  for (const item of cases) {
    const status = attempts.find((a) => a.caseKey === item.caseKey)?.status;
    if (status && status in counts) counts[status as keyof typeof counts]++;
    else counts.notRun++;
  }
  // A retry passing is visible separately; no synthetic overall success for incomplete runs.
  return {
    ...counts,
    total: cases.length,
    complete:
      counts.notRun === 0 && counts.blocked === 0 && counts.skipped === 0,
  };
}
@Injectable()
export class QaRunService {
  constructor(private readonly catalog: QaCatalogService) {}
  async create(m: AccountMembership, siteId: string, input: unknown) {
    const db = await this.catalog.scoped(m, siteId, true),
      body = parseRunInput(input);
    return db.$transaction(async (tx) => {
      const cases = await tx.qaTestCase.findMany({
        where: {
          id: { in: body.caseIds },
          accountId: m.accountId,
          siteId,
          archived: false,
        },
      });
      if (cases.length !== body.caseIds.length) throw invalid();
      const snapshot = [];
      for (const id of body.caseIds) {
        const item = cases.find((c) => c.id === id)!;
        const revision = await tx.qaTestCaseRevision.findFirst({
          where: {
            caseId: item.id,
            accountId: m.accountId,
            version: item.currentVersion,
          },
        });
        if (!revision) throw missing();
        snapshot.push({
          caseId: item.id,
          caseKey: item.caseKey,
          version: item.currentVersion,
          payload: parseCaseInput(revision.payload),
        });
      }
      if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > 1024 * 1024)
        throw invalid();
      return tx.qaTestRun.create({
        data: {
          accountId: m.accountId,
          siteId,
          title: body.title,
          snapshot,
          createdByMemberId: m.memberId,
        },
      });
    });
  }
  async list(m: AccountMembership, siteId: string, before?: string) {
    const db = await this.catalog.scoped(m, siteId);
    if (before !== undefined && !ID.test(before)) throw invalid();
    const rows = await db.qaTestRun.findMany({
      where: {
        accountId: m.accountId,
        siteId,
        ...(before ? { id: { lt: before } } : {}),
      },
      orderBy: { id: 'desc' },
      take: 51,
      select: {
        id: true,
        title: true,
        revision: true,
        createdAt: true,
        createdByMemberId: true,
      },
    });
    const items = rows.slice(0, 50);
    return { items, nextBeforeId: rows.length > 50 ? items.at(-1)!.id : null };
  }
  async get(m: AccountMembership, siteId: string, id: string) {
    const db = await this.catalog.scoped(m, siteId);
    // Read head and latest attempts from a single repeatable-read snapshot.
    return db.$transaction(
      async (tx) => {
        const run = await tx.qaTestRun.findFirst({
          where: { id, accountId: m.accountId, siteId },
        });
        if (!run) throw missing();
        const heads = await tx.qaTestRunAttempt.groupBy({
          by: ['caseKey'],
          where: { accountId: m.accountId, runId: id },
          _max: { attemptNumber: true },
        });
        const latestAttempts = heads.length
          ? await tx.qaTestRunAttempt.findMany({
              where: {
                accountId: m.accountId,
                runId: id,
                OR: heads.map((h) => ({
                  caseKey: h.caseKey,
                  attemptNumber: h._max.attemptNumber!,
                })),
              },
            })
          : [];
        const failedKeys = await tx.qaTestRunAttempt.groupBy({
          by: ['caseKey'],
          where: { accountId: m.accountId, runId: id, status: 'failed' },
        });
        return {
          ...run,
          latestAttempts,
          summary: runSummary(run.snapshot, latestAttempts),
          flakyCaseKeys: latestAttempts
            .filter(
              (a) =>
                a.status === 'passed' &&
                failedKeys.some((f) => f.caseKey === a.caseKey),
            )
            .map((a) => a.caseKey),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
  async attempts(
    m: AccountMembership,
    siteId: string,
    id: string,
    before?: string,
  ) {
    const db = await this.catalog.scoped(m, siteId);
    if (before !== undefined && !ID.test(before)) throw invalid();
    if (
      !(await db.qaTestRun.findFirst({
        where: { id, accountId: m.accountId, siteId },
        select: { id: true },
      }))
    )
      throw missing();
    const rows = await db.qaTestRunAttempt.findMany({
      where: {
        runId: id,
        accountId: m.accountId,
        ...(before ? { id: { lt: before } } : {}),
      },
      orderBy: { id: 'desc' },
      take: 101,
    });
    const items = rows.slice(0, 100);
    return { items, nextBeforeId: rows.length > 100 ? items.at(-1)!.id : null };
  }
  async record(
    m: AccountMembership,
    siteId: string,
    id: string,
    input: unknown,
  ) {
    const db = await this.catalog.scoped(m, siteId, true),
      body = parseRunAttempt(input);
    return db.$transaction(async (tx) => {
      const run = await tx.qaTestRun.findFirst({
        where: { id, accountId: m.accountId, siteId },
      });
      if (!run) throw missing();
      const snapshot = run.snapshot as Array<{
        caseKey: string;
        payload: { type: string };
      }>;
      const item = snapshot.find((c) => c.caseKey === body.caseKey);
      if (!item || item.payload.type !== 'manual') throw invalid();
      const updated = await tx.qaTestRun.updateMany({
        where: {
          id,
          accountId: m.accountId,
          siteId,
          revision: body.expectedRevision,
        },
        data: { revision: body.expectedRevision + 1 },
      });
      if (updated.count !== 1) throw conflict();
      const prior = await tx.qaTestRunAttempt.findFirst({
        where: { runId: id, accountId: m.accountId, caseKey: body.caseKey },
        orderBy: { attemptNumber: 'desc' },
      });
      const attempt = await tx.qaTestRunAttempt.create({
        data: {
          accountId: m.accountId,
          runId: id,
          caseKey: body.caseKey,
          attemptNumber: (prior?.attemptNumber ?? 0) + 1,
          status: body.status,
          comment: body.comment,
          createdByMemberId: m.memberId,
        },
      });
      return { attempt, revision: body.expectedRevision + 1 };
    });
  }
}
