import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { isDeepStrictEqual } from 'node:util';
import { AccountMembership } from '../site-core/account/roles';
import { QaCatalogService } from './qa-catalog.service';
import { parseCaseInput, parseCaseKey } from './qa-case-input';
const invalid = () =>
  new BadRequestException({
    code: 'QA_INVENTORY_INVALID',
    message:
      'Нужно от 1 до 100 уникальных кейсов, до 512 КиБ. Существующие кейсы не перезаписываются.',
  });
@Injectable()
export class QaInventoryService {
  constructor(private readonly catalog: QaCatalogService) {}
  async get(m: AccountMembership, siteId: string, search = '') {
    const db = await this.catalog.scoped(m, siteId);
    if (typeof search !== 'string' || search.length > 100) throw invalid();
    return db.$transaction(async (tx) => {
      const heads = await tx.qaTestCase.findMany({
        where: {
          accountId: m.accountId,
          siteId,
          archived: false,
          ...(search.trim()
            ? {
                OR: [
                  {
                    title: {
                      contains: search.trim(),
                      mode: 'insensitive' as const,
                    },
                  },
                  {
                    caseKey: {
                      contains: search.trim(),
                      mode: 'insensitive' as const,
                    },
                  },
                ],
              }
            : {}),
        },
        orderBy: { caseKey: 'asc' },
        take: 101,
      });
      const items = heads.slice(0, 100);
      const revisions = items.length
        ? await tx.qaTestCaseRevision.findMany({
            where: {
              accountId: m.accountId,
              OR: items.map((c) => ({
                caseId: c.id,
                version: c.currentVersion,
              })),
            },
          })
        : [];
      const output = [];
      let bytes = 0;
      for (const c of items) {
        const r = revisions.find(
          (r) => r.caseId === c.id && r.version === c.currentVersion,
        );
        if (!r) throw invalid();
        const value = { ...c, payload: parseCaseInput(r.payload) };
        const size = Buffer.byteLength(JSON.stringify(value), 'utf8');
        if (bytes + size > 1024 * 1024) break;
        bytes += size;
        output.push(value);
      }
      return {
        items: output,
        truncated: heads.length > 100 || output.length < items.length,
      };
    });
  }
  async import(m: AccountMembership, siteId: string, input: unknown) {
    const db = await this.catalog.scoped(m, siteId, true);
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).some((k) => k !== 'cases')
    )
      throw invalid();
    const list = (input as { cases?: unknown }).cases;
    if (
      !Array.isArray(list) ||
      !list.length ||
      list.length > 100 ||
      Buffer.byteLength(JSON.stringify(list), 'utf8') > 512 * 1024
    )
      throw invalid();
    const rows = list.map((v) => {
      if (
        !v ||
        typeof v !== 'object' ||
        Array.isArray(v) ||
        Object.keys(v).some((k) => !['caseKey', 'payload'].includes(k))
      )
        throw invalid();
      const row = v as { caseKey: unknown; payload: unknown };
      return {
        caseKey: parseCaseKey(row.caseKey),
        payload: parseCaseInput(row.payload),
      };
    });
    if (new Set(rows.map((r) => r.caseKey)).size !== rows.length)
      throw invalid();
    try {
      return await db.$transaction(async (tx) => {
        const existing = await tx.qaTestCase.findMany({
          where: {
            accountId: m.accountId,
            siteId,
            caseKey: { in: rows.map((r) => r.caseKey) },
          },
        });
        if (existing.length) {
          const first = await tx.qaTestCaseRevision.findMany({
            where: {
              accountId: m.accountId,
              caseId: { in: existing.map((c) => c.id) },
              version: 1,
            },
          });
          if (
            existing.length !== rows.length ||
            rows.some((r) => {
              const c = existing.find((c) => c.caseKey === r.caseKey);
              return (
                !c ||
                !isDeepStrictEqual(
                  first.find((v) => v.caseId === c.id)?.payload,
                  r.payload,
                )
              );
            })
          )
            throw new ConflictException({
              code: 'QA_INVENTORY_CONFLICT',
              message:
                'Некоторые ключи уже заняты. Ничего не импортировано; измените ключи или редактируйте существующие кейсы.',
            });
          return { created: 0, replayed: true };
        }
        for (const row of rows) {
          const c = await tx.qaTestCase.create({
            data: {
              accountId: m.accountId,
              siteId,
              caseKey: row.caseKey,
              title: row.payload.title,
              archived: row.payload.archived,
            },
          });
          await tx.qaTestCaseRevision.create({
            data: {
              accountId: m.accountId,
              caseId: c.id,
              version: 1,
              payload: row.payload,
              createdByMemberId: m.memberId,
            },
          });
        }
        return { created: rows.length, replayed: false };
      });
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002')
        throw new ConflictException({
          code: 'QA_INVENTORY_CONFLICT',
          message:
            'Каталог изменился во время импорта. Обновите данные перед повтором.',
        });
      throw e;
    }
  }
}
