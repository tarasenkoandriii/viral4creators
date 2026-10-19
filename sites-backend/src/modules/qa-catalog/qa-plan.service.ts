import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import {
  AccountMembership,
  parseAccountRole,
  parseProductRoles,
  satisfiesProductRoles,
} from '../site-core/account/roles';
import { QaCatalogService, QA_READ } from './qa-catalog.service';
import { parseCaseKey, parseVersion } from './qa-case-input';
import { parsePlan, planObject, planId, QaPlanInput } from './qa-plan-input';
import { freezeQaCases, QaTransaction } from './qa-snapshot';
const missing = () =>
  new NotFoundException({
    code: 'QA_PLAN_NOT_FOUND',
    message: 'План не найден.',
  });
const conflict = () =>
  new ConflictException({
    code: 'QA_PLAN_CONFLICT',
    message: 'План изменён или ключ уже используется. Обновите данные.',
  });
@Injectable()
export class QaPlanService {
  constructor(private readonly catalog: QaCatalogService) {}
  private async payload(
    tx: QaTransaction,
    m: AccountMembership,
    siteId: string,
    body: QaPlanInput,
  ) {
    if (body.assigneeMemberId) {
      const assigned = await tx.siteAccountMember.findFirst({
        where: { id: body.assigneeMemberId, accountId: m.accountId },
      });
      if (
        !assigned ||
        !satisfiesProductRoles(
          {
            role: parseAccountRole(assigned.role) ?? 'operator',
            productRoles: parseProductRoles(assigned.productRoles),
          },
          QA_READ,
        )
      )
        throw new BadRequestException({
          code: 'QA_PLAN_ASSIGNEE_INVALID',
          message: 'Ответственный должен иметь доступ к QA этого кабинета.',
        });
    }
    const snapshot = await freezeQaCases(tx, m.accountId, siteId, body.caseIds);
    return { ...body, snapshot };
  }
  async list(m: AccountMembership, siteId: string, before?: string) {
    const db = await this.catalog.scoped(m, siteId);
    const rows = await db.qaPlan.findMany({
      where: {
        accountId: m.accountId,
        siteId,
        ...(before ? { id: { lt: planId(before) } } : {}),
      },
      orderBy: { id: 'desc' },
      take: 101,
    });
    return {
      items: rows.slice(0, 100),
      nextBeforeId: rows.length > 100 ? rows[99].id : null,
    };
  }
  async get(m: AccountMembership, siteId: string, id: string) {
    const db = await this.catalog.scoped(m, siteId);
    const head = await db.qaPlan.findFirst({
      where: { id: planId(id), accountId: m.accountId, siteId },
    });
    if (!head) throw missing();
    const revision = await db.qaPlanRevision.findFirst({
      where: {
        accountId: m.accountId,
        planId: id,
        version: head.currentVersion,
      },
    });
    if (!revision) throw missing();
    return { ...head, payload: revision.payload };
  }
  async history(
    m: AccountMembership,
    siteId: string,
    id: string,
    before?: string,
  ) {
    const db = await this.catalog.scoped(m, siteId);
    if (
      !(await db.qaPlan.findFirst({
        where: { id: planId(id), accountId: m.accountId, siteId },
        select: { id: true },
      }))
    )
      throw missing();
    const rows = await db.qaPlanRevision.findMany({
      where: {
        accountId: m.accountId,
        planId: id,
        ...(before ? { version: { lt: parseVersion(Number(before)) } } : {}),
      },
      orderBy: { version: 'desc' },
      take: 11,
    });
    const items = [];
    let bytes = 0;
    for (const row of rows.slice(0, 10)) {
      const size = Buffer.byteLength(JSON.stringify(row), 'utf8');
      if (items.length && bytes + size > 2 * 1024 * 1024) break;
      bytes += size;
      items.push(row);
    }
    return {
      items,
      nextBeforeVersion:
        rows.length > items.length ? items.at(-1)!.version : null,
    };
  }
  async create(m: AccountMembership, siteId: string, input: unknown) {
    const db = await this.catalog.scoped(m, siteId, true),
      b = planObject(input, ['planKey', 'payload']),
      planKey = parseCaseKey(b.planKey),
      body = parsePlan(b.payload);
    try {
      return await db.$transaction(async (tx) => {
        const payload = await this.payload(tx, m, siteId, body);
        const row = await tx.qaPlan.create({
          data: {
            accountId: m.accountId,
            siteId,
            planKey,
            title: body.title,
            archived: body.archived,
          },
        });
        await tx.qaPlanRevision.create({
          data: {
            accountId: m.accountId,
            planId: row.id,
            version: 1,
            payload,
            createdByMemberId: m.memberId,
          },
        });
        return row;
      });
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') throw conflict();
      throw e;
    }
  }
  async replace(
    m: AccountMembership,
    siteId: string,
    id: string,
    input: unknown,
  ) {
    const db = await this.catalog.scoped(m, siteId, true),
      b = planObject(input, ['expectedVersion', 'payload']),
      version = parseVersion(b.expectedVersion),
      body = parsePlan(b.payload);
    return db.$transaction(async (tx) => {
      if (
        !(await tx.qaPlan.findFirst({
          where: { id: planId(id), accountId: m.accountId, siteId },
          select: { id: true },
        }))
      )
        throw missing();
      const previous = body.archived
        ? await tx.qaPlanRevision.findFirst({
            where: { accountId: m.accountId, planId: id, version },
          })
        : null;
      const old = previous?.payload as unknown as QaPlanInput & {
        snapshot: Prisma.InputJsonValue;
      };
      const payload =
        old && JSON.stringify(old.caseIds) === JSON.stringify(body.caseIds)
          ? { ...body, snapshot: old.snapshot }
          : await this.payload(tx, m, siteId, body);
      const updated = await tx.qaPlan.updateMany({
        where: { id, accountId: m.accountId, siteId, currentVersion: version },
        data: {
          title: body.title,
          archived: body.archived,
          currentVersion: version + 1,
        },
      });
      if (updated.count !== 1) throw conflict();
      await tx.qaPlanRevision.create({
        data: {
          accountId: m.accountId,
          planId: id,
          version: version + 1,
          payload,
          createdByMemberId: m.memberId,
        },
      });
      return { id, currentVersion: version + 1 };
    });
  }
  async start(
    m: AccountMembership,
    siteId: string,
    id: string,
    input: unknown,
  ) {
    const db = await this.catalog.scoped(m, siteId, true),
      b = planObject(input, [
        'expectedVersion',
        'environmentIndex',
        'requestId',
      ]),
      version = parseVersion(b.expectedVersion);
    if (
      !Number.isSafeInteger(b.environmentIndex) ||
      (b.environmentIndex as number) < 0 ||
      (b.environmentIndex as number) > 11 ||
      typeof b.requestId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        b.requestId,
      )
    )
      throw new BadRequestException({ code: 'QA_PLAN_INVALID' });
    const runId =
      'qap' +
      createHash('sha256')
        .update(`${m.accountId}:${siteId}:${id}:${b.requestId.toLowerCase()}`)
        .digest('hex')
        .slice(0, 52);
    return db
      .$transaction(
        async (tx) => {
          const existing = await tx.qaTestRun.findFirst({
            where: { id: runId, accountId: m.accountId, siteId },
          });
          if (existing) {
            const context = existing.context as Record<string, unknown> | null;
            if (
              context?.planId !== id ||
              context?.planVersion !== version ||
              context?.environmentIndex !== b.environmentIndex
            )
              throw conflict();
            return { ...existing, replayed: true };
          }
          const head = await tx.qaPlan.findFirst({
            where: { id: planId(id), accountId: m.accountId, siteId },
          });
          if (!head) throw missing();
          if (head.archived || head.currentVersion !== version)
            throw conflict();
          const rev = await tx.qaPlanRevision.findFirst({
            where: { accountId: m.accountId, planId: id, version },
          });
          if (!rev) throw missing();
          const p = rev.payload as unknown as QaPlanInput & {
            snapshot: Prisma.InputJsonValue;
          };
          const env = p.environments[b.environmentIndex as number];
          if (!env) throw new BadRequestException({ code: 'QA_PLAN_INVALID' });
          if (p.assigneeMemberId) {
            const member = await tx.siteAccountMember.findFirst({
              where: { id: p.assigneeMemberId, accountId: m.accountId },
            });
            if (
              !member ||
              !satisfiesProductRoles(
                {
                  role: parseAccountRole(member.role) ?? 'operator',
                  productRoles: parseProductRoles(member.productRoles),
                },
                QA_READ,
              )
            )
              throw new BadRequestException({
                code: 'QA_PLAN_ASSIGNEE_INVALID',
              });
          }
          return {
            ...(await tx.qaTestRun.create({
              data: {
                id: runId,
                accountId: m.accountId,
                siteId,
                title: `${head.planKey} v${version} · ${env.name}`.slice(
                  0,
                  200,
                ),
                snapshot: p.snapshot,
                context: {
                  planId: id,
                  planKey: head.planKey,
                  planVersion: version,
                  environmentIndex: b.environmentIndex as number,
                  environment: { ...env },
                  suite: p.suite,
                  assigneeMemberId: p.assigneeMemberId,
                },
                createdByMemberId: m.memberId,
              },
            })),
            replayed: false,
          };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      )
      .catch(async (e) => {
        if (['P2002', 'P2034'].includes((e as { code?: string }).code ?? '')) {
          const existing = await db.qaTestRun.findFirst({
            where: { id: runId, accountId: m.accountId, siteId },
          });
          const c = existing?.context as Record<string, unknown> | null;
          if (
            existing &&
            c?.planId === id &&
            c.planVersion === version &&
            c.environmentIndex === b.environmentIndex
          )
            return { ...existing, replayed: true };
          throw conflict();
        }
        throw e;
      });
  }
}
