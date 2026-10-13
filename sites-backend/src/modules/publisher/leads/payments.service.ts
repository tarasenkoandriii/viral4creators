/**
 * AI Publisher — оплаты клиентов (P-D, проектный документ §6.5
 * `pub_payments`; ТЗ §9 Payment, §15; AT-CORE-24).
 *
 *  - Запись — факт, который фиксирует человек: вид (`payment_received |
 *    refund | contract_signed`), плательщик (`external | internal | test |
 *    self`), сумма в минимальных единицах, валюта, дата, `paymentRef`
 *    (`@@unique` — повтор не создаёт вторую оплату), документ.
 *  - Статусы: `pending → confirmed | cancelled`, `confirmed → refunded`;
 *    суть оплаты неизменна (триггер) — исправление новой записью.
 *  - `isNewCustomer` фиксируется при подтверждении по истории внешних
 *    оплат проспекта (вместе со слитыми в него) и `priorExternalPayment`:
 *    неизвестная история — `unknown` (основной CAC тогда не подтверждается,
 *    ТЗ §15).
 *  - Выручка, CAC и «коммерческая валидация» — ТОЛЬКО `external` +
 *    `payment_received` + `confirmed` (`isRevenuePayment`); внутренняя,
 *    тестовая и собственная оплата выручкой не бывают.
 *  - Возврат полученной оплаты (`confirmed → refunded`) в той же транзакции
 *    пишет запись `refund` (`paymentRef = refund:<id>`, `confirmedAt` —
 *    момент возврата): единое правило P-D/P-E (аудит P-E S1-3) — снимки
 *    отчётов знают, КОГДА оплату вернули, `report-staleness` видит возврат
 *    после снимка, выручка и CAC его вычитают.
 */
import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { PaymentView, PaymentsPage } from '../contracts/leads-api';
import {
  CLIENT_PAYMENT_STATUSES,
  PAYER_KINDS,
  PAYMENT_RECORD_TYPES,
} from '../contracts/states';
import { PubError, assertNoIssues, validationError } from '../core/errors';
import { isCurrency, parseMinor } from '../core/money';
import { looksLikeContact, piiIssues } from '../core/pii-guard';
import type { AuditInput, ProductRef, PubTx } from '../core/ports';
import { ProspectsService } from './prospects.service';
import { autoRefundRef } from '../reports/metrics/economics';

type PaymentStatus = (typeof CLIENT_PAYMENT_STATUSES)[number];

/** Разрешённые переходы оплаты клиента. */
export const CLIENT_PAYMENT_TRANSITIONS: Readonly<
  Record<PaymentStatus, readonly PaymentStatus[]>
> = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['refunded'],
  refunded: [],
  cancelled: [],
};

/** Выручка = внешняя подтверждённая полученная оплата (AT-CORE-24). */
export function isRevenuePayment(p: {
  payerKind: string;
  recordType: string;
  status: string;
}): boolean {
  return (
    p.payerKind === 'external' &&
    p.recordType === 'payment_received' &&
    p.status === 'confirmed'
  );
}

/**
 * Новый ли клиент (ТЗ §15): только для внешней полученной оплаты; есть
 * более ранняя внешняя оплата в реестре — `no`; иначе по
 * `priorExternalPayment` проспекта (`no` → `yes`, `yes` → `no`,
 * неизвестно → `unknown`).
 */
export function newCustomerOf(i: {
  payerKind: string;
  recordType: string;
  earlierExternalPayments: number;
  priorExternalPayment: string;
}): 'yes' | 'no' | 'unknown' {
  if (i.payerKind !== 'external' || i.recordType !== 'payment_received')
    return 'no';
  if (i.earlierExternalPayments > 0) return 'no';
  if (i.priorExternalPayment === 'no') return 'yes';
  if (i.priorExternalPayment === 'yes') return 'no';
  return 'unknown';
}

/**
 * `paymentRef` похож на контакт (S3-6): e-mail или ссылка мессенджера —
 * всегда; номер из цифр (телефон) — если в нём нет букв. Номер документа
 * с буквами (`INV-2026-0012345`) телефоном не считается.
 */
export function paymentRefLooksLikeContact(ref: string): boolean {
  if (!looksLikeContact(ref)) return false;
  if (/@|[.]me\/|:\/\//i.test(ref)) return true;
  return !/\p{L}/u.test(ref);
}

type Row = {
  id: string;
  prospectId: string;
  leadId: string | null;
  recordType: string;
  payerKind: string;
  amountMinor: bigint;
  currency: string;
  occurredAt: Date;
  paymentRef: string;
  confirmation: string | null;
  status: string;
  confirmedBy: string | null;
  confirmedAt: Date | null;
  isNewCustomer: string;
  createdAt: Date;
};

export function paymentView(r: Row): PaymentView {
  return {
    id: r.id,
    prospectId: r.prospectId,
    leadId: r.leadId,
    recordType: r.recordType as PaymentView['recordType'],
    payerKind: r.payerKind as PaymentView['payerKind'],
    amountMinor: r.amountMinor.toString(),
    currency: r.currency,
    occurredAt: r.occurredAt.toISOString(),
    paymentRef: r.paymentRef,
    confirmation: r.confirmation,
    status: r.status as PaymentView['status'],
    confirmedBy: r.confirmedBy,
    confirmedAt: r.confirmedAt?.toISOString() ?? null,
    isNewCustomer: r.isNewCustomer as PaymentView['isNewCustomer'],
    revenue: isRevenuePayment(r),
    createdAt: r.createdAt.toISOString(),
  };
}

/** Сводка страницы: выручка по валютам и прочие виды отдельно. */
export function paymentsSummary(rows: readonly Row[]): PaymentsPage['summary'] {
  const revenue = new Map<string, bigint>();
  const other: Record<string, number> = {};
  for (const r of rows) {
    if (isRevenuePayment(r)) {
      revenue.set(r.currency, (revenue.get(r.currency) ?? 0n) + r.amountMinor);
    } else {
      const k = `${r.payerKind}:${r.recordType}:${r.status}`;
      other[k] = (other[k] ?? 0) + 1;
    }
  }
  return {
    revenueByCurrency: Object.fromEntries(
      [...revenue].map(([c, v]) => [c, v.toString()]),
    ),
    nonRevenueCount: other,
    commercialValidation: revenue.size > 0,
  };
}

const TEXT_MAX = 2000;

@Injectable()
export class PaymentsService {
  constructor(private readonly prospects: ProspectsService) {}

  async get(tx: PubTx, productId: string, id: string): Promise<Row> {
    const r = await tx.pubPayment.findFirst({ where: { id, productId } });
    if (!r) throw new PubError('PUB_NOT_FOUND', { object: 'payment' });
    return r as Row;
  }

  async list(
    tx: PubTx,
    productId: string,
    q: { prospectId?: unknown },
  ): Promise<PaymentsPage> {
    const rows = (await tx.pubPayment.findMany({
      where: {
        productId,
        ...(typeof q.prospectId === 'string' && q.prospectId
          ? { prospectId: q.prospectId }
          : {}),
      },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: 1000,
    })) as Row[];
    return {
      items: rows.map(paymentView),
      nextBefore: null,
      summary: paymentsSummary(rows),
    };
  }

  async create(
    tx: PubTx,
    product: ProductRef,
    body: Record<string, unknown>,
    opKey: string,
    actor: string,
  ): Promise<{ view: PaymentView; audit: AuditInput[] }> {
    const fields: Array<{ field: string; code: string }> = [];
    if (
      !(PAYMENT_RECORD_TYPES as readonly unknown[]).includes(body.recordType)
    ) {
      fields.push({ field: 'recordType', code: 'enum' });
    }
    if (!(PAYER_KINDS as readonly unknown[]).includes(body.payerKind)) {
      fields.push({ field: 'payerKind', code: 'enum' });
    }
    const amount = parseMinor(body.amountMinor);
    if (amount === null || amount <= 0n)
      fields.push({ field: 'amountMinor', code: 'range' });
    if (!isCurrency(body.currency))
      fields.push({ field: 'currency', code: 'format' });
    const occurredAt =
      typeof body.occurredAt === 'string' ? new Date(body.occurredAt) : null;
    if (!occurredAt || Number.isNaN(occurredAt.getTime())) {
      fields.push({ field: 'occurredAt', code: 'format' });
    }
    const ref =
      typeof body.paymentRef === 'string' ? body.paymentRef.trim() : '';
    if (!ref || ref.length > 200)
      fields.push({ field: 'paymentRef', code: 'length' });
    const confirmation =
      typeof body.confirmation === 'string' && body.confirmation.trim()
        ? body.confirmation.trim()
        : null;
    if (confirmation && confirmation.length > TEXT_MAX) {
      fields.push({ field: 'confirmation', code: 'length' });
    }
    if (typeof body.prospectId !== 'string')
      fields.push({ field: 'prospectId', code: 'required' });
    if (fields.length) throw validationError(fields);
    // `paymentRef` открыт в списках и выгрузке (аудит P-D S3-6) — без
    // контакта плательщика.
    if (paymentRefLooksLikeContact(ref)) {
      throw validationError([{ field: 'paymentRef', code: 'pii' }]);
    }
    assertNoIssues(piiIssues({ confirmation }));
    const prospect = await this.prospects.rootOf(
      tx,
      product.id,
      body.prospectId as string,
    );
    let leadId: string | null = null;
    let testLead = false;
    if (typeof body.leadId === 'string' && body.leadId) {
      const lead = await tx.pubLead.findFirst({
        where: { id: body.leadId, productId: product.id },
        select: { id: true, prospectId: true, testFlag: true },
      });
      if (!lead) throw new PubError('PUB_NOT_FOUND', { object: 'lead' });
      // Заявка — этого проспекта (с учётом слияния), иначе оплата
      // приписалась бы чужому человеку.
      const leadRoot = lead.prospectId
        ? (await this.prospects.rootOf(tx, product.id, lead.prospectId)).id
        : null;
      if (leadRoot !== prospect.id) {
        throw validationError([{ field: 'leadId', code: 'prospect_mismatch' }]);
      }
      leadId = lead.id;
      testLead = lead.testFlag;
    }
    // Тестовая заявка, команда/партнёр, не внешний проспект — выручкой
    // быть не может: `external` для них — явный отказ (S3-6).
    if (
      body.payerKind === 'external' &&
      (testLead || prospect.isTeamOrPartner || !prospect.isExternal)
    ) {
      throw validationError([
        {
          field: 'payerKind',
          code: testLead ? 'test_lead' : 'not_external_prospect',
        },
      ]);
    }
    const dup = await tx.pubPayment.findFirst({
      where: { productId: product.id, paymentRef: ref },
      select: { id: true },
    });
    if (dup)
      throw new PubError('PUB_CONFLICT', {
        reason: 'payment_ref_exists',
        paymentId: dup.id,
      });
    const r = (await tx.pubPayment.create({
      data: {
        accountId: product.accountId,
        productId: product.id,
        prospectId: prospect.id,
        leadId,
        recordType: body.recordType as string,
        payerKind: body.payerKind as string,
        amountMinor: amount as bigint,
        currency: body.currency as string,
        occurredAt: occurredAt as Date,
        paymentRef: ref,
        confirmation,
        opKey,
        createdBy: actor,
      },
    })) as Row;
    return {
      view: paymentView(r),
      audit: [
        {
          objectType: 'payment',
          objectId: r.id,
          action: 'create',
          toStatus: 'pending',
          meta: {
            recordType: r.recordType,
            payerKind: r.payerKind,
            currency: r.currency,
          },
        },
      ],
    };
  }

  async transition(
    tx: PubTx,
    product: ProductRef,
    id: string,
    to: PaymentStatus,
    body: Record<string, unknown>,
    actor: string,
    now: Date,
  ): Promise<{ view: PaymentView; audit: AuditInput[] }> {
    const p = await this.get(tx, product.id, id);
    const from = p.status as PaymentStatus;
    if (!CLIENT_PAYMENT_TRANSITIONS[from].includes(to)) {
      throw new PubError('PUB_TRANSITION_INVALID', {
        machine: 'client_payment',
        from,
        to,
        allowed: CLIENT_PAYMENT_TRANSITIONS[from],
      });
    }
    const data: Record<string, unknown> = { status: to };
    if (to === 'confirmed') {
      const confirmation =
        typeof body.confirmation === 'string' && body.confirmation.trim()
          ? body.confirmation.trim()
          : p.confirmation;
      if (confirmation && confirmation.length > TEXT_MAX) {
        throw validationError([{ field: 'confirmation', code: 'length' }]);
      }
      assertNoIssues(piiIssues({ confirmation }));
      const root = await this.prospects.rootOf(tx, product.id, p.prospectId);
      const group = await tx.pubProspect.findMany({
        where: {
          productId: product.id,
          OR: [{ id: root.id }, { mergedIntoId: root.id }],
        },
        select: { id: true },
      });
      const earlier = await tx.pubPayment.count({
        where: {
          productId: product.id,
          id: { not: p.id },
          prospectId: { in: group.map((g) => g.id) },
          payerKind: 'external',
          recordType: 'payment_received',
          status: { in: ['confirmed', 'refunded'] },
          occurredAt: { lte: p.occurredAt },
        },
      });
      data.confirmation = confirmation;
      data.confirmedBy = actor;
      data.confirmedAt = now;
      data.isNewCustomer = newCustomerOf({
        payerKind: p.payerKind,
        recordType: p.recordType,
        earlierExternalPayments: earlier,
        priorExternalPayment: root.priorExternalPayment,
      });
    }
    const res = await tx.pubPayment.updateMany({
      where: { id, productId: product.id, status: from },
      data,
    });
    if (res.count !== 1)
      throw new PubError('PUB_CONFLICT', { reason: 'status_changed' });
    const audit: AuditInput[] = [];
    if (to === 'refunded' && p.recordType === 'payment_received') {
      const refund = await tx.pubPayment.create({
        data: {
          accountId: product.accountId,
          productId: product.id,
          prospectId: p.prospectId,
          leadId: p.leadId,
          recordType: 'refund',
          payerKind: p.payerKind,
          amountMinor: p.amountMinor,
          currency: p.currency,
          occurredAt: now,
          paymentRef: autoRefundRef(p.id),
          status: 'confirmed',
          confirmedBy: actor,
          confirmedAt: now,
          isNewCustomer: 'no',
          opKey: randomUUID(),
          createdBy: actor,
        },
      });
      audit.push({
        objectType: 'payment',
        objectId: refund.id,
        action: 'create',
        toStatus: 'confirmed',
        meta: { recordType: 'refund', refundOfRef: p.id, currency: p.currency },
      });
    }
    const view = paymentView(await this.get(tx, product.id, id));
    return {
      view,
      audit: [
        {
          objectType: 'payment',
          objectId: id,
          action: 'transition',
          fromStatus: from,
          toStatus: to,
          meta: { isNewCustomer: view.isNewCustomer, revenue: view.revenue },
        },
        ...audit,
      ],
    };
  }
}
