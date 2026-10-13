/**
 * AI Publisher — учёт времени TimeEntry (P-E, проектный документ §6.6,
 * §4.2; ТЗ §17). Своё время пишет любой участник с ролью (кроме viewer),
 * чужое и ставки — product_owner. Ставка роли фиксируется в записи на
 * момент записи только при УТВЕРЖДЁННОМ `rates_by_role` (иначе NULL —
 * отчёт пишет «не менее»). Категория `setup|development` — инвестиция
 * (триггер держит `isInvestment`): одна сумма труда — в одной категории.
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { ListPage } from '../contracts/common';
import type { FieldIssue } from '../contracts/errors';
import type { TimeCategory, TimeEntryView } from '../contracts/reports-api';
import {
  TIME_ENTRY_CATEGORIES,
  TIME_ENTRY_ROLES,
  isOneOf,
} from '../contracts/states';
import { PubError, validationError } from '../core/errors';
import { piiIssues } from '../core/pii-guard';
import type { AuditInput, ProductRef, PubTx } from '../core/ports';
import { memberAccessIn } from '../core/product-access.service';
import { casUpdate, parseExpectedRevision } from '../core/revision';
import { can, type PubAccess } from '../core/roles';

type Row = Prisma.PubTimeEntryGetPayload<object>;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
export const INVESTMENT_CATEGORIES = ['setup', 'development'] as const;

export function timeEntryView(r: Row): TimeEntryView {
  return {
    id: r.id,
    memberId: r.memberId,
    memberDisplayName: r.memberDisplayName,
    role: r.role as TimeEntryView['role'],
    task: r.task,
    featureId: r.featureId,
    contentId: r.contentId,
    minutes: r.minutes,
    rateMinorPerHour:
      r.rateMinorPerHour === null ? null : r.rateMinorPerHour.toString(),
    rateParamVersion: r.rateParamVersion,
    workDate: r.workDate.toISOString().slice(0, 10),
    category: r.category as TimeCategory,
    isInvestment: r.isInvestment,
    createdAt: r.createdAt.toISOString(),
    revision: r.revision,
  };
}

function workDateOf(v: unknown, issues: FieldIssue[]): Date | undefined {
  const m = typeof v === 'string' ? DATE_RE.exec(v) : null;
  if (!m) {
    issues.push({
      field: 'workDate',
      code: v === undefined ? 'required' : 'format',
    });
    return undefined;
  }
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (d.toISOString().slice(0, 10) !== v) {
    issues.push({ field: 'workDate', code: 'format' });
    return undefined;
  }
  return d;
}

interface Fields {
  task?: string;
  minutes?: number;
  workDate?: Date;
  category?: TimeCategory;
  featureId?: string | null;
  contentId?: string | null;
}

function parseFields(body: Record<string, unknown>, required: boolean): Fields {
  const issues: FieldIssue[] = [];
  const out: Fields = {};
  if (required || body.task !== undefined) {
    if (
      typeof body.task !== 'string' ||
      !body.task.trim() ||
      [...body.task].length > 2000
    ) {
      issues.push({
        field: 'task',
        code: body.task === undefined ? 'required' : 'length',
      });
    } else {
      out.task = body.task.trim();
      issues.push(...piiIssues({ task: out.task }));
    }
  }
  if (required || body.minutes !== undefined) {
    const n = body.minutes;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 1440) {
      issues.push({
        field: 'minutes',
        code: n === undefined ? 'required' : 'range',
      });
    } else out.minutes = n;
  }
  if (required || body.workDate !== undefined)
    out.workDate = workDateOf(body.workDate, issues);
  if (required || body.category !== undefined) {
    if (!isOneOf(TIME_ENTRY_CATEGORIES, body.category))
      issues.push({ field: 'category', code: 'enum' });
    else out.category = body.category;
  }
  if (body.featureId !== undefined) {
    if (body.featureId === null) out.featureId = null;
    else if (
      typeof body.featureId === 'string' &&
      /^F[0-9]{2}$/.test(body.featureId)
    )
      out.featureId = body.featureId;
    else issues.push({ field: 'featureId', code: 'format' });
  }
  if (body.contentId !== undefined) {
    if (body.contentId === null) out.contentId = null;
    else if (typeof body.contentId === 'string' && ID_RE.test(body.contentId))
      out.contentId = body.contentId;
    else issues.push({ field: 'contentId', code: 'format' });
  }
  if (issues.length) throw validationError(issues);
  return out;
}

@Injectable()
export class TimeEntriesService {
  async list(
    tx: PubTx,
    product: ProductRef,
    access: PubAccess,
    q: { before?: unknown; limit?: unknown; member?: unknown },
  ): Promise<ListPage<TimeEntryView>> {
    const others = can(access, 'time.others');
    const where: Prisma.PubTimeEntryWhereInput = { productId: product.id };
    if (!others) where.memberId = access.memberId;
    else if (typeof q.member === 'string' && ID_RE.test(q.member))
      where.memberId = q.member;
    const limit = Math.min(Math.max(Number(q.limit ?? 50) || 50, 1), 100);
    if (typeof q.before === 'string' && ID_RE.test(q.before)) {
      const b = await tx.pubTimeEntry.findFirst({
        where: { id: q.before, productId: product.id },
        select: { createdAt: true },
      });
      if (b) where.createdAt = { lt: b.createdAt };
    }
    const rows = await tx.pubTimeEntry.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    return {
      items: rows.map(timeEntryView),
      nextBefore: rows.length === limit ? rows[rows.length - 1].id : null,
    };
  }

  private async rateFor(
    tx: PubTx,
    productId: string,
    role: string,
  ): Promise<{ rate: bigint | null; version: number | null }> {
    const p = await tx.pubParameter.findFirst({
      where: { productId, key: 'rates_by_role' },
      select: { status: true, value: true, version: true },
    });
    if (!p || p.status !== 'approved') return { rate: null, version: null };
    const v = (p.value as { rates?: Record<string, unknown> } | null)?.rates?.[
      role
    ];
    return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
      ? { rate: BigInt(v), version: p.version }
      : { rate: null, version: null };
  }

  private async checkContent(
    tx: PubTx,
    productId: string,
    contentId: string | null | undefined,
  ): Promise<void> {
    if (!contentId) return;
    const c = await tx.pubContent.findFirst({
      where: { id: contentId, productId },
      select: { id: true },
    });
    if (!c) throw validationError([{ field: 'contentId', code: 'not_found' }]);
  }

  async create(
    tx: PubTx,
    product: ProductRef,
    access: PubAccess,
    body: Record<string, unknown>,
    actor: string,
  ): Promise<{ row: Row; audit: AuditInput[] }> {
    const memberId =
      body.memberId === undefined ? access.memberId : body.memberId;
    if (typeof memberId !== 'string' || !ID_RE.test(memberId)) {
      throw validationError([{ field: 'memberId', code: 'format' }]);
    }
    let target: PubAccess | null = access;
    if (memberId !== access.memberId) {
      if (!can(access, 'time.others'))
        throw new PubError('PUB_ROLE_REQUIRED', { action: 'time.others' });
      target = await memberAccessIn(tx, product.id, memberId);
      if (!target)
        throw validationError([{ field: 'memberId', code: 'not_member' }]);
    }
    if (!isOneOf(TIME_ENTRY_ROLES, body.role))
      throw validationError([{ field: 'role', code: 'enum' }]);
    const role = body.role;
    const holds = role === 'admin' ? target.admin : target.roles.has(role);
    if (!holds) throw validationError([{ field: 'role', code: 'not_held' }]);
    const f = parseFields(body, true);
    await this.checkContent(tx, product.id, f.contentId);
    const rate = await this.rateFor(tx, product.id, role);
    const row = await tx.pubTimeEntry.create({
      data: {
        accountId: product.accountId,
        productId: product.id,
        memberId,
        memberDisplayName: `Учасник …${memberId.slice(-6)}`,
        role,
        task: f.task as string,
        featureId: f.featureId ?? null,
        contentId: f.contentId ?? null,
        minutes: f.minutes as number,
        rateMinorPerHour: rate.rate,
        rateParamVersion: rate.version,
        workDate: f.workDate as Date,
        category: f.category as string,
        isInvestment: (INVESTMENT_CATEGORIES as readonly string[]).includes(
          f.category as string,
        ),
        createdBy: actor,
      },
    });
    return {
      row,
      audit: [
        {
          objectType: 'time_entry',
          objectId: row.id,
          action: 'create',
          meta: { minutes: row.minutes, category: row.category },
        },
      ],
    };
  }

  async patch(
    tx: PubTx,
    product: ProductRef,
    access: PubAccess,
    id: string,
    body: Record<string, unknown>,
  ): Promise<{ row: Row; audit: AuditInput[] }> {
    const expected = parseExpectedRevision(body.expectedRevision);
    const cur = ID_RE.test(id)
      ? await tx.pubTimeEntry.findFirst({
          where: { id, productId: product.id },
        })
      : null;
    if (!cur) throw new PubError('PUB_NOT_FOUND');
    if (cur.memberId !== access.memberId && !can(access, 'time.others')) {
      throw new PubError('PUB_ROLE_REQUIRED', { action: 'time.others' });
    }
    const f = parseFields(body, false);
    await this.checkContent(tx, product.id, f.contentId);
    const data: Record<string, unknown> = { ...f };
    if (f.category)
      data.isInvestment = (INVESTMENT_CATEGORIES as readonly string[]).includes(
        f.category,
      );
    await casUpdate(tx.pubTimeEntry, id, expected, data);
    const row = (await tx.pubTimeEntry.findFirst({ where: { id } })) as Row;
    return {
      row,
      audit: [
        {
          objectType: 'time_entry',
          objectId: id,
          action: 'update',
          meta: { fields: Object.keys(f).join(',') },
        },
      ],
    };
  }
}
