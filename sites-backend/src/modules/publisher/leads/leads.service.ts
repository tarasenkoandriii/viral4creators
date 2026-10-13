/**
 * AI Publisher — заявки в кабинете (P-D, проектный документ §6.5, §7.4,
 * §11.3, §15.3; ТЗ §9 Lead, §10, §21; AT-CORE-06, 07, 09).
 *
 *  - очередь и карточка — без контакта, имени, текста задачи и заметок;
 *  - переход статуса — машина §7.4 (`core/state-machines.ts`), каждая
 *    смена — строка `pub_lead_decisions` (append-only): код причины для
 *    `rejected|lost` и отмены решения, `confirmedInterestAt` для
 *    `qualified`, свободный текст — только в шифр (`noteEnc`, AAD = id
 *    решения). Решает человек: маршрут — только участник с ролью, AI-код
 *    этот сервис не импортирует (правило графа `publisher-ai-no-authority`);
 *  - тест-флаг — с причиной; история — журнал аудита (кто, когда, откуда
 *    куда, основание); событие успеха заявки получает тот же флаг;
 *  - ретенция (§15.3): закрытие ставит `reviewDueAt = closedAt + 90`;
 *    удаление контакта — `DELETE pub_lead_contacts` + обнуление
 *    шифрованных заметок + `erasedAt` + обезличенная `pub_erasures`;
 *    сохранение — основание и следующая дата (не дальше 90 дней).
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  LeadCardView,
  LeadListItem,
  LeadTestFilter,
  RetentionDueItem,
} from '../contracts/leads-api';
import { LEAD_TEST_FILTERS } from '../contracts/leads-api';
import {
  LIST_LIMIT_DEFAULT,
  LIST_LIMIT_MAX,
  type ListPage,
  type ProductCtx,
} from '../contracts/common';
import {
  LEAD_REASON_CODES,
  LEAD_STATUSES,
  type LeadStatus,
} from '../contracts/states';
import { PubError, assertNoIssues, validationError } from '../core/errors';
import {
  addKyivCalendarDays,
  reviewDueForClosed,
  reviewDueForOpen,
} from '../core/kyiv-time';
import { piiIssues } from '../core/pii-guard';
import type { AuditInput, PubTx } from '../core/ports';
import { memberAccessIn } from '../core/product-access.service';
import { casUpdate, parseExpectedRevision } from '../core/revision';
import { can } from '../core/roles';
import {
  LEAD_MACHINE,
  assertTransition,
  type Actor,
} from '../core/state-machines';
import { erasedLeadColumns, leadEraseEffect } from './erase-effect';
import { LeadEnrichService } from './lead-enrich.job';
import { leadCardView, leadListItem, type LeadRow } from './lead-views';
import {
  ProspectsService,
  newId,
  noteOf,
  sealLeadNote,
} from './prospects.service';

export const LEAD_SELECT = {
  id: true,
  publicRef: true,
  status: true,
  receivedAt: true,
  contactMethod: true,
  budgetRange: true,
  selfReportedChannel: true,
  testFlag: true,
  testReason: true,
  suspectedSpam: true,
  responsibleMemberId: true,
  responsibleDisplayName: true,
  prospectId: true,
  duplicateOfLeadId: true,
  campaignId: true,
  contentId: true,
  placementId: true,
  contactDueAt: true,
  reviewDueAt: true,
  closedAt: true,
  erasedAt: true,
  enrichedAt: true,
  revision: true,
  consentState: true,
  sessionRef: true,
  contentSlugRaw: true,
  placementCodeRaw: true,
  attribution: true,
  retentionBasis: true,
} as const;

const CLOSED: readonly string[] = ['rejected', 'won', 'lost'];
/** Переходы, требующие кода причины (§6.5, триггер `pub_lead_decisions_guard`). */
function needsReason(from: string, to: string): boolean {
  return (
    to === 'rejected' ||
    to === 'lost' ||
    (to === 'contacted' && ['qualified', 'rejected', 'lost'].includes(from))
  );
}

export interface OpStep {
  actor: string;
  now: Date;
}

export interface LeadOpResult {
  card: LeadCardView;
  audit: AuditInput[];
}

/** Обезличенный `requestHash` — общее правило стирания (`erase-effect.ts`). */
export { erasedRequestHash } from './erase-effect';

/** Короткий текст основания: строка 3..2000, без контакта (pii-guard). */
export function basisOf(v: unknown, field = 'reason'): string {
  if (typeof v !== 'string')
    throw validationError([{ field, code: 'required' }]);
  const t = v.trim();
  if (t.length < 3 || [...t].length > 2000) {
    throw validationError([{ field, code: 'length' }]);
  }
  assertNoIssues(piiIssues({ [field]: t }));
  return t;
}

function dateOf(v: unknown, field: string): Date {
  if (typeof v !== 'string')
    throw validationError([{ field, code: 'required' }]);
  const d = new Date(v);
  if (Number.isNaN(d.getTime()))
    throw validationError([{ field, code: 'format' }]);
  return d;
}

@Injectable()
export class LeadsService {
  constructor(
    private readonly prospects: ProspectsService,
    private readonly enrich: LeadEnrichService,
  ) {}

  async row(tx: PubTx, productId: string, id: string): Promise<LeadRow> {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
      throw new PubError('PUB_NOT_FOUND');
    }
    const r = await tx.pubLead.findFirst({
      where: { id, productId },
      select: LEAD_SELECT,
    });
    if (!r) throw new PubError('PUB_NOT_FOUND');
    return r as LeadRow;
  }

  async card(
    tx: PubTx,
    productId: string,
    id: string,
    now: Date,
  ): Promise<LeadCardView> {
    const r = await this.row(tx, productId, id);
    const [prospect, decisions, links, contact, outbox, notifications] =
      await Promise.all([
        r.prospectId
          ? tx.pubProspect.findFirst({
              where: { id: r.prospectId, productId },
              select: { code: true },
            })
          : Promise.resolve(null),
        tx.pubLeadDecision.findMany({
          where: { leadId: id, productId },
          orderBy: [{ decidedAt: 'asc' }, { id: 'asc' }],
        }),
        tx.pubLeadProspectLink.findMany({
          where: { leadId: id, productId },
          orderBy: [{ validFrom: 'asc' }, { id: 'asc' }],
          select: {
            prospectId: true,
            validFrom: true,
            reason: true,
            decidedBy: true,
          },
        }),
        tx.pubLeadContact.findFirst({
          where: { leadId: id, productId },
          select: { matchHash: true },
        }),
        tx.pubLeadOutbox.findFirst({
          where: { leadId: id, productId },
          select: { status: true, attempts: true, lastErrorCode: true },
        }),
        tx.pubNotification.findMany({
          where: { leadId: id, productId },
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            kind: true,
            status: true,
            recipientMemberId: true,
          },
        }),
      ]);
    const codes = links.length
      ? await tx.pubProspect.findMany({
          where: {
            productId,
            id: { in: [...new Set(links.map((l) => l.prospectId))] },
          },
          select: { id: true, code: true },
        })
      : [];
    const codeOf = new Map(codes.map((c) => [c.id, c.code]));
    const dups = contact?.matchHash
      ? await tx.pubLead.findMany({
          where: {
            productId,
            id: { not: id },
            leadContactLeadOf: { some: { matchHash: contact.matchHash } },
          },
          select: { id: true },
          orderBy: { receivedAt: 'asc' },
          take: 20,
        })
      : [];
    return leadCardView(
      r,
      {
        prospectCode: prospect?.code ?? null,
        decisions: decisions.map((d) => ({
          id: d.id,
          fromStatus: d.fromStatus as LeadStatus,
          toStatus: d.toStatus as LeadStatus,
          reasonCode: d.reasonCode,
          hasNote: d.noteEnc !== null,
          confirmedInterestAt: d.confirmedInterestAt?.toISOString() ?? null,
          decidedBy: d.decidedBy,
          decidedAt: d.decidedAt.toISOString(),
          supersedesId: d.supersedesId,
        })),
        prospectLinks: links.map((l) => ({
          prospectId: l.prospectId,
          prospectCode: codeOf.get(l.prospectId) ?? '',
          validFrom: l.validFrom.toISOString(),
          reason: l.reason,
          decidedBy: l.decidedBy,
        })),
        possibleDuplicates: dups.map((d) => d.id),
        outbox: outbox ?? null,
        notifications,
      },
      now,
    );
  }

  /** Очередь: новые сверху; `before` — id последней строки страницы. */
  async list(
    tx: PubTx,
    productId: string,
    q: {
      status?: unknown;
      responsible?: unknown;
      test?: unknown;
      before?: unknown;
      limit?: unknown;
    },
    now: Date,
    opts: { maxLimit?: number } = {},
  ): Promise<ListPage<LeadListItem>> {
    const where: Prisma.PubLeadWhereInput = { productId };
    if (q.status !== undefined) {
      if (!(LEAD_STATUSES as readonly unknown[]).includes(q.status)) {
        throw validationError([{ field: 'status', code: 'enum' }]);
      }
      where.status = q.status as string;
    }
    if (typeof q.responsible === 'string' && q.responsible) {
      where.responsibleMemberId =
        q.responsible === 'none' ? null : q.responsible;
    }
    const test = (q.test ?? 'include') as LeadTestFilter;
    if (!(LEAD_TEST_FILTERS as readonly string[]).includes(test)) {
      throw validationError([{ field: 'test', code: 'enum' }]);
    }
    if (test === 'exclude') where.testFlag = false;
    if (test === 'only') where.testFlag = true;
    const max = opts.maxLimit ?? LIST_LIMIT_MAX;
    const limit = Math.min(
      Math.max(Number(q.limit ?? LIST_LIMIT_DEFAULT) || LIST_LIMIT_DEFAULT, 1),
      max,
    );
    if (typeof q.before === 'string' && q.before) {
      const c = await tx.pubLead.findFirst({
        where: { id: q.before, productId },
        select: { id: true, receivedAt: true },
      });
      if (c) {
        where.OR = [
          { receivedAt: { lt: c.receivedAt } },
          { receivedAt: c.receivedAt, id: { lt: c.id } },
        ];
      }
    }
    const rows = (await tx.pubLead.findMany({
      where,
      orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: LEAD_SELECT,
    })) as LeadRow[];
    const page = rows.slice(0, limit);
    const pids = [
      ...new Set(page.map((r) => r.prospectId).filter((x): x is string => !!x)),
    ];
    const codes = pids.length
      ? await tx.pubProspect.findMany({
          where: { productId, id: { in: pids } },
          select: { id: true, code: true },
        })
      : [];
    const codeOf = new Map(codes.map((c) => [c.id, c.code]));
    return {
      items: page.map((r) =>
        leadListItem(
          r,
          r.prospectId ? (codeOf.get(r.prospectId) ?? null) : null,
          now,
        ),
      ),
      nextBefore: rows.length > limit ? page[page.length - 1].id : null,
    };
  }

  // ── Переходы (§7.4) ─────────────────────────────────────────────────────

  async transition(
    tx: PubTx,
    product: ProductCtx,
    actors: Actor[],
    id: string,
    body: Record<string, unknown>,
    step: OpStep,
  ): Promise<LeadOpResult> {
    const expected = parseExpectedRevision(body.expectedRevision);
    const to = body.to;
    if (!(LEAD_STATUSES as readonly unknown[]).includes(to)) {
      throw validationError([
        { field: 'to', code: to === undefined ? 'required' : 'enum' },
      ]);
    }
    let lead = await this.row(tx, product.id, id);
    const from = lead.status as LeadStatus;
    assertTransition(LEAD_MACHINE, from, to as LeadStatus, { actors });
    let reasonCode: string | null = null;
    if (body.reasonCode !== undefined && body.reasonCode !== null) {
      if (
        !(LEAD_REASON_CODES as readonly unknown[]).includes(body.reasonCode)
      ) {
        throw validationError([{ field: 'reasonCode', code: 'enum' }]);
      }
      reasonCode = body.reasonCode as string;
    }
    if (needsReason(from, to as string) && !reasonCode) {
      throw validationError([{ field: 'reasonCode', code: 'required' }]);
    }
    const note = noteOf(body.note);
    let confirmedInterestAt: Date | null = null;
    if (to === 'qualified') {
      confirmedInterestAt = dateOf(
        body.confirmedInterestAt,
        'confirmedInterestAt',
      );
      if (confirmedInterestAt.getTime() > step.now.getTime() + 5 * 60 * 1000) {
        throw validationError([
          { field: 'confirmedInterestAt', code: 'future' },
        ]);
      }
      if (!lead.prospectId) {
        await this.enrich.enrichInTx(tx, product, id, step.now);
        lead = await this.row(tx, product.id, id);
      }
      if (!lead.prospectId) {
        throw validationError([{ field: 'prospectId', code: 'required' }]);
      }
      const prospect = await this.prospects.rootOf(
        tx,
        product.id,
        lead.prospectId,
      );
      if (!prospect.isExternal || prospect.isTeamOrPartner) {
        throw validationError([{ field: 'prospect', code: 'not_external' }]);
      }
      // ДТ-3 (интеграция Z-1, Р-PUB-Z1-9; заменяет Р-PUB-D-3): тестовая
      // заявка квалифицируется в ЛЮБОМ продукте (AT-CORE-06 — «тестовая
      // квалификация» видна в диагностике); запись остаётся `testFlag=true`
      // и исключается из деловых сумм (паспорт, отчёты P-E).
    }
    const decisionId = newId('ld_');
    const reversal =
      to === 'contacted' && ['qualified', 'rejected', 'lost'].includes(from);
    const prev = reversal
      ? await tx.pubLeadDecision.findFirst({
          where: { leadId: id, productId: product.id },
          orderBy: [{ decidedAt: 'desc' }, { id: 'desc' }],
          select: { id: true },
        })
      : null;
    await tx.pubLeadDecision.create({
      data: {
        id: decisionId,
        accountId: product.accountId,
        productId: product.id,
        leadId: id,
        fromStatus: from,
        toStatus: to as string,
        reasonCode,
        noteEnc: note ? sealLeadNote(note, decisionId) : null,
        confirmedInterestAt,
        decidedBy: step.actor,
        decidedAt: step.now,
        supersedesId: prev?.id ?? null,
        createdBy: step.actor,
      },
    });
    const closing = CLOSED.includes(to as string);
    const data: Record<string, unknown> = {
      status: to,
      closedAt: closing ? step.now : null,
    };
    if (!lead.erasedAt && !lead.retentionBasis) {
      data.reviewDueAt = closing
        ? reviewDueForClosed(step.now)
        : await this.openReviewDue(tx, product.id, lead.receivedAt, step.now);
    }
    await casUpdate(tx.pubLead, id, expected, data);
    return {
      card: await this.card(tx, product.id, id, step.now),
      audit: [
        {
          objectType: 'lead',
          objectId: id,
          action: 'transition',
          fromStatus: from,
          toStatus: to as string,
          meta: { reasonCode, hasNote: note !== null, decisionId },
        },
      ],
    };
  }

  /** `reviewDueForOpen` (не позже t72) и не в прошлом. */
  async openReviewDue(
    tx: PubTx,
    productId: string,
    receivedAt: Date,
    now: Date,
  ): Promise<Date> {
    const pilot = await tx.pubExperiment.findFirst({
      where: { productId, kind: 'pilot' },
      orderBy: { version: 'desc' },
      select: { t72: true },
    });
    const due = reviewDueForOpen(receivedAt, pilot?.t72 ?? null, null);
    return due.getTime() > now.getTime()
      ? due
      : reviewDueForOpen(receivedAt, null, now);
  }

  // ── Ответственный, тест-флаг, дубль, проспект ──────────────────────────

  async assign(
    tx: PubTx,
    product: ProductCtx,
    id: string,
    body: Record<string, unknown>,
    step: OpStep,
  ): Promise<LeadOpResult> {
    const expected = parseExpectedRevision(body.expectedRevision);
    const raw = body.responsibleMemberId;
    await this.row(tx, product.id, id);
    let memberId: string | null = null;
    if (raw !== null) {
      if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(raw)) {
        throw validationError([
          {
            field: 'responsibleMemberId',
            code: raw === undefined ? 'required' : 'format',
          },
        ]);
      }
      const access = await memberAccessIn(tx, product.id, raw);
      if (!access)
        throw validationError([
          { field: 'responsibleMemberId', code: 'not_member' },
        ]);
      if (!can(access, 'lead.manage')) {
        throw validationError([
          { field: 'responsibleMemberId', code: 'no_lead_access' },
        ]);
      }
      memberId = raw;
    }
    await casUpdate(tx.pubLead, id, expected, {
      responsibleMemberId: memberId,
      responsibleDisplayName: memberId
        ? `Учасник …${memberId.slice(-6)}`
        : null,
    });
    return {
      card: await this.card(tx, product.id, id, step.now),
      audit: [
        {
          objectType: 'lead',
          objectId: id,
          action: 'assign',
          meta: { responsibleMemberId: memberId },
        },
      ],
    };
  }

  async setTestFlag(
    tx: PubTx,
    product: ProductCtx,
    id: string,
    body: Record<string, unknown>,
    step: OpStep,
  ): Promise<LeadOpResult> {
    const expected = parseExpectedRevision(body.expectedRevision);
    if (typeof body.testFlag !== 'boolean') {
      throw validationError([
        {
          field: 'testFlag',
          code: body.testFlag === undefined ? 'required' : 'type',
        },
      ]);
    }
    const flag = body.testFlag;
    const reason = basisOf(body.reason, 'reason');
    const testReason = body.testReason ?? 'manual';
    if (testReason !== 'team' && testReason !== 'manual') {
      throw validationError([{ field: 'testReason', code: 'enum' }]);
    }
    const lead = await this.row(tx, product.id, id);
    if (lead.testFlag === flag)
      throw validationError([{ field: 'testFlag', code: 'unchanged' }]);
    if (!flag && product.kind !== 'working') {
      throw validationError([{ field: 'testFlag', code: 'test_product' }]);
    }
    // Системная причина приёма (вид/режим продукта) не снимается вручную:
    // заявка тестового хоста не становится «реальной» (аудит P-D S2-1).
    if (
      !flag &&
      (lead.testReason === 'test_mode' || lead.testReason === 'test_product')
    ) {
      throw validationError([{ field: 'testFlag', code: lead.testReason }]);
    }
    await casUpdate(tx.pubLead, id, expected, {
      testFlag: flag,
      testReason: flag ? testReason : null,
    });
    // Событие успеха этой заявки — тот же флаг (диагностика ≡ заявка).
    await tx.pubEvent.updateMany({
      where: { productId: product.id, leadId: id },
      data: { testFlag: flag, updatedAt: step.now },
    });
    const sessionRows = await this.propagateTestFlag(
      tx,
      product.id,
      id,
      lead.sessionRef,
      flag,
      step.now,
    );
    return {
      card: await this.card(tx, product.id, id, step.now),
      audit: [
        {
          objectType: 'lead',
          objectId: id,
          action: 'update',
          fromStatus: lead.testFlag ? 'test' : 'not_test',
          toStatus: flag ? 'test' : 'not_test',
          reason,
          meta: {
            field: 'testFlag',
            testReason: flag ? testReason : null,
            previousTestReason: lead.testReason,
            sessionRows,
          },
        },
      ],
    };
  }

  /**
   * Флаг заявки — на её сессию и события сессии (аудит P-D S2-1; ТЗ §28:
   * данные команды исключаются из отчётов спроса — сессии и просмотры
   * сотрудника не остаются в паспорте F11 и когортах P-E).
   *
   *  - Пометка: сессия и все события `sessionRef` становятся тестовыми.
   *  - Снятие: только если в сессии не осталось других тестовых заявок, и
   *    только записи, принятые в текущем периоде live (с `liveSince`):
   *    принятое в режиме test остаётся тестовым по причине приёма.
   *
   * Возвращает число изменённых строк сессии и событий (для журнала).
   */
  private async propagateTestFlag(
    tx: PubTx,
    productId: string,
    leadId: string,
    sessionRef: string | null,
    flag: boolean,
    now: Date,
  ): Promise<number> {
    if (!sessionRef) return 0;
    if (flag) {
      const s = await tx.pubSession.updateMany({
        where: { productId, sessionRef, testFlag: false },
        data: { testFlag: true },
      });
      const e = await tx.pubEvent.updateMany({
        where: { productId, sessionRef, testFlag: false },
        data: { testFlag: true, updatedAt: now },
      });
      return s.count + e.count;
    }
    const otherTest = await tx.pubLead.count({
      where: { productId, sessionRef, testFlag: true, id: { not: leadId } },
    });
    if (otherTest > 0) return 0;
    const prod = await tx.pubProduct.findFirst({
      where: { id: productId },
      select: { mode: true, liveSince: true },
    });
    if (prod?.mode !== 'live' || !prod.liveSince) return 0;
    const s = await tx.pubSession.updateMany({
      where: {
        productId,
        sessionRef,
        testFlag: true,
        startedAt: { gte: prod.liveSince },
      },
      data: { testFlag: false },
    });
    const e = await tx.pubEvent.updateMany({
      where: {
        productId,
        sessionRef,
        testFlag: true,
        occurredAt: { gte: prod.liveSince },
      },
      data: { testFlag: false, updatedAt: now },
    });
    return s.count + e.count;
  }

  async markDuplicate(
    tx: PubTx,
    product: ProductCtx,
    id: string,
    body: Record<string, unknown>,
    step: OpStep,
  ): Promise<LeadOpResult> {
    const expected = parseExpectedRevision(body.expectedRevision);
    const reason = basisOf(body.reason, 'reason');
    const target = body.duplicateOfLeadId;
    await this.row(tx, product.id, id);
    if (target !== null) {
      if (typeof target !== 'string') {
        throw validationError([
          {
            field: 'duplicateOfLeadId',
            code: target === undefined ? 'required' : 'type',
          },
        ]);
      }
      if (target === id)
        throw validationError([{ field: 'duplicateOfLeadId', code: 'self' }]);
      await this.row(tx, product.id, target);
    }
    await casUpdate(tx.pubLead, id, expected, { duplicateOfLeadId: target });
    return {
      card: await this.card(tx, product.id, id, step.now),
      audit: [
        {
          objectType: 'lead',
          objectId: id,
          action: 'update',
          reason,
          meta: { field: 'duplicateOfLeadId', duplicateOfLeadId: target },
        },
      ],
    };
  }

  /** Проспект заявки вручную: существующий (`manual_assign`) или новый (`manual_split`). */
  async setProspect(
    tx: PubTx,
    product: ProductCtx,
    id: string,
    body: Record<string, unknown>,
    step: OpStep,
  ): Promise<LeadOpResult> {
    const expected = parseExpectedRevision(body.expectedRevision);
    const reason = basisOf(body.reason, 'reason');
    const lead = await this.row(tx, product.id, id);
    const raw = body.prospectId;
    if (typeof raw !== 'string' || !raw) {
      throw validationError([{ field: 'prospectId', code: 'required' }]);
    }
    let prospectId: string;
    let linkReason: 'manual_split' | 'manual_assign';
    if (raw === 'new') {
      prospectId = (await this.prospects.create(tx, product, {}, step.actor))
        .id;
      linkReason = 'manual_split';
    } else {
      prospectId = (await this.prospects.rootOf(tx, product.id, raw)).id;
      if (prospectId === lead.prospectId) {
        throw validationError([{ field: 'prospectId', code: 'unchanged' }]);
      }
      linkReason = 'manual_assign';
    }
    await casUpdate(tx.pubLead, id, expected, {});
    await this.prospects.link(
      tx,
      product,
      id,
      prospectId,
      linkReason,
      step.actor,
      step.now,
    );
    return {
      card: await this.card(tx, product.id, id, step.now),
      audit: [
        {
          objectType: 'lead',
          objectId: id,
          action: linkReason === 'manual_split' ? 'split' : 'assign',
          reason,
          meta: {
            field: 'prospectId',
            fromProspectId: lead.prospectId,
            toProspectId: prospectId,
          },
        },
      ],
    };
  }

  // ── Ретенция (§15.3) ────────────────────────────────────────────────────

  async erase(
    tx: PubTx,
    product: ProductCtx,
    id: string,
    body: Record<string, unknown>,
    step: OpStep,
  ): Promise<LeadOpResult> {
    const expected = parseExpectedRevision(body.expectedRevision);
    const basis = basisOf(body.basis, 'basis');
    const lead = await this.row(tx, product.id, id);
    if (lead.erasedAt)
      throw validationError([{ field: 'lead', code: 'already_erased' }]);
    const contacts = await tx.pubLeadContact.deleteMany({
      where: { leadId: id, productId: product.id },
    });
    const notes = await tx.pubLeadDecision.updateMany({
      where: { leadId: id, productId: product.id, noteEnc: { not: null } },
      data: { noteEnc: null },
    });
    // Заметка проспекта — о человеке: стирается, если у проспекта не
    // осталось заявок с неудалённым контактом (общее правило стирания
    // `leadEraseEffect`, его же применяет восстановление P-E).
    let prospectNote = false;
    if (lead.prospectId) {
      const siblings = await tx.pubLead.findMany({
        where: { productId: product.id, prospectId: lead.prospectId },
        select: { id: true, prospectId: true, erasedAt: true },
      });
      const effect = leadEraseEffect(
        siblings.map((l) => ({
          id: l.id,
          prospectId: l.prospectId,
          erased: l.erasedAt !== null,
        })),
        new Set([id]),
      );
      if (effect.prospectNotes.has(lead.prospectId)) {
        const r = await tx.pubProspect.updateMany({
          where: {
            id: lead.prospectId,
            productId: product.id,
            noteEnc: { not: null },
          },
          data: { noteEnc: null },
        });
        prospectNote = r.count > 0;
      }
    }
    // requestHash — HMAC канонического тела (имя, контакт, задача): в том же
    // UPDATE заменяется обезличенным значением (аудит P-D S3-9; триггер
    // разрешает это только вместе с erasedAt — миграция publisher_leads_fn).
    await casUpdate(tx.pubLead, id, expected, erasedLeadColumns(id, step.now));
    await tx.pubErasure.create({
      data: {
        accountId: product.accountId,
        productId: product.id,
        leadId: id,
        erasedAt: step.now,
        erasedBy: step.actor,
        basis,
        scope: {
          active: true,
          exports: true,
          protectedRows: contacts.count,
          decisionNotes: notes.count,
          prospectNote,
        },
        createdBy: step.actor,
      },
    });
    return {
      card: await this.card(tx, product.id, id, step.now),
      audit: [
        {
          objectType: 'lead',
          objectId: id,
          action: 'erase',
          reason: basis,
          meta: {
            protectedRows: contacts.count,
            decisionNotes: notes.count,
            prospectNote,
          },
        },
      ],
    };
  }

  async retain(
    tx: PubTx,
    product: ProductCtx,
    id: string,
    body: Record<string, unknown>,
    step: OpStep,
  ): Promise<LeadOpResult> {
    const expected = parseExpectedRevision(body.expectedRevision);
    const basis = basisOf(body.basis, 'basis');
    const next = dateOf(body.nextReviewAt, 'nextReviewAt');
    if (next.getTime() <= step.now.getTime()) {
      throw validationError([{ field: 'nextReviewAt', code: 'past' }]);
    }
    if (next.getTime() > addKyivCalendarDays(step.now, 90).getTime()) {
      throw validationError([{ field: 'nextReviewAt', code: 'range' }]);
    }
    const lead = await this.row(tx, product.id, id);
    if (lead.erasedAt)
      throw validationError([{ field: 'lead', code: 'already_erased' }]);
    await casUpdate(tx.pubLead, id, expected, {
      retentionBasis: basis,
      reviewDueAt: next,
    });
    return {
      card: await this.card(tx, product.id, id, step.now),
      audit: [
        {
          objectType: 'lead',
          objectId: id,
          action: 'update',
          reason: basis,
          meta: {
            field: 'reviewDueAt',
            from: lead.reviewDueAt.toISOString(),
            to: next.toISOString(),
          },
        },
      ],
    };
  }

  /** Заявки с наступившим сроком пересмотра (и в ближайшие `withinDays`). */
  async retentionDue(
    tx: PubTx,
    productId: string,
    withinDays: number,
    now: Date,
  ): Promise<{ items: RetentionDueItem[] }> {
    const until = withinDays > 0 ? addKyivCalendarDays(now, withinDays) : now;
    const rows = await tx.pubLead.findMany({
      where: { productId, erasedAt: null, reviewDueAt: { lte: until } },
      orderBy: [{ reviewDueAt: 'asc' }, { id: 'asc' }],
      take: 500,
      select: {
        id: true,
        publicRef: true,
        status: true,
        reviewDueAt: true,
        closedAt: true,
        retentionBasis: true,
        responsibleMemberId: true,
      },
    });
    return {
      items: rows.map((r) => ({
        leadId: r.id,
        publicRef: r.publicRef,
        status: r.status as LeadStatus,
        reviewDueAt: r.reviewDueAt.toISOString(),
        closedAt: r.closedAt?.toISOString() ?? null,
        retentionBasis: r.retentionBasis,
        responsibleMemberId: r.responsibleMemberId,
        overdue: r.reviewDueAt.getTime() <= now.getTime(),
      })),
    };
  }
}
