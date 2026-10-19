import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AccountMembership } from '../site-core/account/roles';
import { QaCatalogService } from './qa-catalog.service';
import { findingFingerprint, parseFinding } from './qa-finding-input';
const missing = () =>
  new NotFoundException({
    code: 'QA_FINDING_NOT_FOUND',
    message: 'Замечание не найдено.',
  });
const conflict = () =>
  new ConflictException({
    code: 'QA_FINDING_CONFLICT',
    message:
      'Замечание изменилось. Обновите данные; черновик можно сохранить отдельно.',
  });
function id(v: string) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(v))
    throw new BadRequestException({ code: 'QA_FINDING_INVALID' });
  return v;
}
@Injectable()
export class QaFindingService {
  constructor(private readonly catalog: QaCatalogService) {}
  private async validateSource(
    tx: Parameters<
      Parameters<
        Awaited<ReturnType<QaCatalogService['scoped']>>['$transaction']
      >[0]
    >[0],
    m: AccountMembership,
    siteId: string,
    source: ReturnType<typeof parseFinding>['source'],
  ) {
    if (!source) return;
    const run = await tx.qaTestRun.findFirst({
      where: { id: source.runId, accountId: m.accountId, siteId },
      select: { snapshot: true },
    });
    const snapshot = run?.snapshot;
    if (
      !Array.isArray(snapshot) ||
      !snapshot.some(
        (item) =>
          item &&
          typeof item === 'object' &&
          !Array.isArray(item) &&
          item.caseKey === source.caseKey,
      )
    )
      throw new BadRequestException({ code: 'QA_FINDING_SOURCE_INVALID' });
    const attempt = await tx.qaTestRunAttempt.findFirst({
      where: {
        id: source.attemptId,
        runId: source.runId,
        accountId: m.accountId,
        caseKey: source.caseKey,
      },
      select: { id: true },
    });
    if (!attempt)
      throw new BadRequestException({ code: 'QA_FINDING_SOURCE_INVALID' });
  }
  async list(m: AccountMembership, siteId: string, before?: string) {
    const db = await this.catalog.scoped(m, siteId);
    const rows = await db.qaFinding.findMany({
      where: {
        accountId: m.accountId,
        siteId,
        ...(before ? { id: { lt: id(before) } } : {}),
      },
      orderBy: { id: 'desc' },
      take: 101,
    });
    return {
      items: rows.slice(0, 100),
      nextBeforeId: rows.length > 100 ? rows[99].id : null,
    };
  }
  async get(m: AccountMembership, siteId: string, findingId: string) {
    const db = await this.catalog.scoped(m, siteId);
    const finding = await db.qaFinding.findFirst({
      where: { id: id(findingId), accountId: m.accountId, siteId },
    });
    if (!finding) throw missing();
    const revision = await db.qaFindingRevision.findFirst({
      where: { accountId: m.accountId, findingId, version: finding.revision },
    });
    if (!revision) throw missing();
    return { ...finding, payload: revision.payload };
  }
  async history(
    m: AccountMembership,
    siteId: string,
    findingId: string,
    before?: string,
  ) {
    const db = await this.catalog.scoped(m, siteId);
    if (
      !(await db.qaFinding.findFirst({
        where: { id: id(findingId), accountId: m.accountId, siteId },
        select: { id: true },
      }))
    )
      throw missing();
    if (
      before !== undefined &&
      (!/^[1-9][0-9]{0,9}$/.test(before) || Number(before) > 2147483647)
    )
      throw new BadRequestException({ code: 'QA_FINDING_INVALID' });
    const rows = await db.qaFindingRevision.findMany({
      where: {
        accountId: m.accountId,
        findingId,
        ...(before ? { version: { lt: Number(before) } } : {}),
      },
      orderBy: { version: 'desc' },
      take: 101,
    });
    return {
      items: rows.slice(0, 100),
      nextBeforeVersion: rows.length > 100 ? rows[99].version : null,
    };
  }
  async create(m: AccountMembership, siteId: string, input: unknown) {
    const db = await this.catalog.scoped(m, siteId, true),
      payload = parseFinding(input),
      fingerprint = findingFingerprint(payload);
    try {
      return await db.$transaction(async (tx) => {
        await this.validateSource(tx, m, siteId, payload.source);
        const row = await tx.qaFinding.create({
          data: {
            accountId: m.accountId,
            siteId,
            fingerprint,
            title: payload.title,
            status: payload.status,
            severity: payload.severity,
          },
        });
        await tx.qaFindingRevision.create({
          data: {
            accountId: m.accountId,
            findingId: row.id,
            version: 1,
            payload: payload as unknown as Prisma.InputJsonValue,
            createdByMemberId: m.memberId,
          },
        });
        return row;
      });
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') {
        const existing = await db.qaFinding.findFirst({
          where: { accountId: m.accountId, siteId, fingerprint },
          select: { id: true },
        });
        if (existing)
          throw new ConflictException({
            code: 'QA_FINDING_DUPLICATE',
            message:
              'Такое наблюдение уже существует. Дополните его доказательства.',
            details: { findingId: existing.id },
          });
      }
      throw e;
    }
  }
  async replace(
    m: AccountMembership,
    siteId: string,
    findingId: string,
    input: unknown,
  ) {
    const db = await this.catalog.scoped(m, siteId, true);
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).some(
        (k) => !['expectedRevision', 'payload'].includes(k),
      )
    )
      throw new BadRequestException({ code: 'QA_FINDING_INVALID' });
    const body = input as { expectedRevision?: unknown; payload?: unknown };
    if (
      !Number.isSafeInteger(body.expectedRevision) ||
      (body.expectedRevision as number) < 1 ||
      (body.expectedRevision as number) > 2147483646
    )
      throw new BadRequestException({ code: 'QA_FINDING_INVALID' });
    const revision = body.expectedRevision as number,
      payload = parseFinding(body.payload);
    const fingerprint = findingFingerprint(payload);
    try {
      return await db.$transaction(async (tx) => {
        if (
          !(await tx.qaFinding.findFirst({
            where: { id: id(findingId), accountId: m.accountId, siteId },
            select: { id: true },
          }))
        )
          throw missing();
        await this.validateSource(tx, m, siteId, payload.source);
        const changed = await tx.qaFinding.updateMany({
          where: { id: findingId, accountId: m.accountId, siteId, revision },
          data: {
            fingerprint,
            title: payload.title,
            status: payload.status,
            severity: payload.severity,
            revision: revision + 1,
          },
        });
        if (changed.count !== 1) throw conflict();
        await tx.qaFindingRevision.create({
          data: {
            accountId: m.accountId,
            findingId,
            version: revision + 1,
            payload: payload as unknown as Prisma.InputJsonValue,
            createdByMemberId: m.memberId,
          },
        });
        return { id: findingId, revision: revision + 1 };
      });
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') {
        const existing = await db.qaFinding.findFirst({
          where: { accountId: m.accountId, siteId, fingerprint },
          select: { id: true },
        });
        if (existing && existing.id !== findingId)
          throw new ConflictException({
            code: 'QA_FINDING_DUPLICATE',
            message:
              'Такое наблюдение уже существует. Дополните его доказательства.',
            details: { findingId: existing.id },
          });
      }
      throw e;
    }
  }
}
