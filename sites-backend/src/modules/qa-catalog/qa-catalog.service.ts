import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SitesDb } from '../../prisma/sites-db.service';
import {
  AccountMembership,
  satisfiesProductRoles,
} from '../site-core/account/roles';
import { parseCaseInput, parseCaseKey, parseVersion } from './qa-case-input';
export const QA_READ = { qa: ['admin', 'viewer'] } as const;
export const QA_WRITE = { qa: ['admin'] } as const;
const missing = () =>
  new NotFoundException({
    code: 'QA_CASE_NOT_FOUND',
    message: 'Сайт или тест не найден.',
  });
const conflict = () =>
  new ConflictException({
    code: 'QA_CASE_CONFLICT',
    message:
      'Тест уже существует или изменён другим пользователем. Обновите данные.',
  });
@Injectable()
export class QaCatalogService {
  constructor(private readonly db: SitesDb) {}
  private async scoped(m: AccountMembership, siteId: string, write = false) {
    if (!satisfiesProductRoles(m, write ? QA_WRITE : QA_READ))
      throw new ForbiddenException({
        code: 'PRODUCT_ROLE_REQUIRED',
        message: 'Недостаточно прав для каталога тестов.',
      });
    const db = this.db.forAccount(m.accountId);
    if (
      !(await db.site.findFirst({
        where: { id: siteId, accountId: m.accountId },
        select: { id: true },
      }))
    )
      throw missing();
    return db;
  }
  async list(m: AccountMembership, siteId: string, after?: string) {
    const db = await this.scoped(m, siteId);
    const afterKey = after === undefined ? undefined : parseCaseKey(after);
    const rows = await db.qaTestCase.findMany({
      where: {
        accountId: m.accountId,
        siteId,
        ...(afterKey ? { caseKey: { gt: afterKey } } : {}),
      },
      orderBy: { caseKey: 'asc' },
      take: 101,
    });
    const items = rows.slice(0, 100);
    return {
      items,
      nextAfterKey: rows.length > 100 ? items.at(-1)?.caseKey : null,
    };
  }
  async get(m: AccountMembership, siteId: string, id: string) {
    const db = await this.scoped(m, siteId);
    const item = await db.qaTestCase.findFirst({
      where: { id, siteId, accountId: m.accountId },
    });
    if (!item) throw missing();
    const revision = await db.qaTestCaseRevision.findFirst({
      where: {
        caseId: id,
        version: item.currentVersion,
        accountId: m.accountId,
      },
    });
    return { ...item, revision };
  }
  async history(
    m: AccountMembership,
    siteId: string,
    id: string,
    before?: string,
  ) {
    const db = await this.scoped(m, siteId);
    if (
      !(await db.qaTestCase.findFirst({
        where: { id, siteId, accountId: m.accountId },
        select: { id: true },
      }))
    )
      throw missing();
    const beforeVersion =
      before === undefined ? undefined : parseVersion(Number(before));
    const rows = await db.qaTestCaseRevision.findMany({
      where: {
        caseId: id,
        accountId: m.accountId,
        ...(beforeVersion ? { version: { lt: beforeVersion } } : {}),
      },
      orderBy: { version: 'desc' },
      take: 101,
    });
    const items = rows.slice(0, 100);
    return {
      items,
      nextBeforeVersion: rows.length > 100 ? items.at(-1)?.version : null,
    };
  }
  async create(m: AccountMembership, siteId: string, input: unknown) {
    const db = await this.scoped(m, siteId, true);
    const body = input as { caseKey?: unknown; payload?: unknown };
    const caseKey = parseCaseKey(body?.caseKey),
      payload = parseCaseInput(body?.payload);
    try {
      return await db.$transaction(async (tx) => {
        const item = await tx.qaTestCase.create({
          data: {
            accountId: m.accountId,
            siteId,
            caseKey,
            title: payload.title,
            archived: payload.archived,
          },
        });
        await tx.qaTestCaseRevision.create({
          data: {
            accountId: m.accountId,
            caseId: item.id,
            version: 1,
            payload,
            createdByMemberId: m.memberId,
          },
        });
        return item;
      });
    } catch (e) {
      if ((e as { code?: string })?.code === 'P2002') throw conflict();
      throw e;
    }
  }
  async replace(
    m: AccountMembership,
    siteId: string,
    id: string,
    input: unknown,
  ) {
    const db = await this.scoped(m, siteId, true);
    const body = input as { expectedVersion?: unknown; payload?: unknown };
    const version = parseVersion(body?.expectedVersion),
      payload = parseCaseInput(body?.payload);
    return db.$transaction(async (tx) => {
      const item = await tx.qaTestCase.findFirst({
        where: { id, siteId, accountId: m.accountId },
      });
      if (!item) throw missing();
      const changed = await tx.qaTestCase.updateMany({
        where: { id, siteId, accountId: m.accountId, currentVersion: version },
        data: {
          title: payload.title,
          archived: payload.archived,
          currentVersion: version + 1,
        },
      });
      if (changed.count !== 1) throw conflict();
      await tx.qaTestCaseRevision.create({
        data: {
          accountId: m.accountId,
          caseId: id,
          version: version + 1,
          payload,
          createdByMemberId: m.memberId,
        },
      });
      return { id, caseKey: item.caseKey, currentVersion: version + 1 };
    });
  }
}
