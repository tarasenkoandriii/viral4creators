/**
 * AI Publisher — отметка «очередь заявок проверена сегодня» (P-D,
 * проектный документ §6.5 `pub_queue_checks`; ТЗ §20 «оператор проверяет
 * очередь минимум раз в рабочий день независимо от уведомлений»;
 * ручная часть AT-CORE-05). Отметка — append-only, одна на участника и
 * рабочую дату Kyiv; повтор в тот же день возвращает прежнюю (не 409).
 * Список за период показывает рабочие дни календаря `contact_sla` без
 * отметки — пропуск виден на обзоре.
 */
import { Injectable } from '@nestjs/common';
import type { QueueCheckView, QueueChecksPage } from '../contracts/leads-api';
import { validationError } from '../core/errors';
import {
  addKyivCalendarDays,
  isBusinessDay,
  kyivDateOf,
  kyivDayStart,
} from '../core/kyiv-time';
import type { AuditInput, ProductRef, PubTx } from '../core/ports';
import { calendarOf } from './lead-enrich.job';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 366;

type Row = {
  id: string;
  checkedBy: string;
  checkedAt: Date;
  workDate: Date;
  openCount: number;
  overdueCount: number;
};

/** `workDate` хранится как `date`: драйвер отдаёт полночь UTC. */
const dateOfRow = (d: Date): string => d.toISOString().slice(0, 10);

export function queueCheckView(r: Row): QueueCheckView {
  return {
    id: r.id,
    checkedBy: r.checkedBy,
    checkedAt: r.checkedAt.toISOString(),
    workDate: dateOfRow(r.workDate),
    openCount: r.openCount,
    overdueCount: r.overdueCount,
  };
}

@Injectable()
export class QueueChecksService {
  async check(
    tx: PubTx,
    product: ProductRef,
    actor: string,
    now: Date,
  ): Promise<{ status: 200 | 201; view: QueueCheckView; audit: AuditInput[] }> {
    const workDate = kyivDateOf(now);
    const day = new Date(`${workDate}T00:00:00.000Z`);
    const existing = await tx.pubQueueCheck.findFirst({
      where: { productId: product.id, workDate: day, checkedBy: actor },
    });
    if (existing)
      return { status: 200, view: queueCheckView(existing), audit: [] };
    const [openCount, overdueCount] = await Promise.all([
      tx.pubLead.count({
        where: {
          productId: product.id,
          status: { in: ['new', 'contacted'] },
          erasedAt: null,
        },
      }),
      tx.pubLead.count({
        where: {
          productId: product.id,
          status: 'new',
          erasedAt: null,
          contactDueAt: { lt: now },
        },
      }),
    ]);
    const r = await tx.pubQueueCheck.create({
      data: {
        accountId: product.accountId,
        productId: product.id,
        checkedBy: actor,
        checkedAt: now,
        workDate: day,
        openCount,
        overdueCount,
        createdBy: actor,
      },
    });
    return {
      status: 201,
      view: queueCheckView(r),
      audit: [
        {
          objectType: 'queue_check',
          objectId: r.id,
          action: 'create',
          meta: { workDate, openCount, overdueCount },
        },
      ],
    };
  }

  async list(
    tx: PubTx,
    productId: string,
    q: { from?: unknown; to?: unknown },
    now: Date,
  ): Promise<QueueChecksPage> {
    const to = typeof q.to === 'string' ? q.to : kyivDateOf(now);
    const from =
      typeof q.from === 'string'
        ? q.from
        : kyivDateOf(addKyivCalendarDays(now, -13));
    if (!DATE_RE.test(from) || !DATE_RE.test(to) || from > to) {
      throw validationError([{ field: 'from', code: 'range' }]);
    }
    const rows = await tx.pubQueueCheck.findMany({
      where: {
        productId,
        workDate: {
          gte: new Date(`${from}T00:00:00.000Z`),
          lte: new Date(`${to}T00:00:00.000Z`),
        },
      },
      orderBy: [{ workDate: 'desc' }, { checkedAt: 'desc' }],
    });
    const sla = await tx.pubParameter.findFirst({
      where: { productId, key: 'contact_sla' },
      select: { value: true },
    });
    const calendar = calendarOf(sla?.value);
    const checked = new Set(rows.map((r) => dateOfRow(r.workDate)));
    const missing: string[] = [];
    let d = kyivDayStart(from);
    for (let i = 0; i < MAX_RANGE_DAYS; i++) {
      const date = kyivDateOf(d);
      if (date > to) break;
      if (isBusinessDay(date, calendar) && !checked.has(date))
        missing.push(date);
      d = addKyivCalendarDays(d, 1);
    }
    return { items: rows.map(queueCheckView), missingWorkDates: missing };
  }
}
