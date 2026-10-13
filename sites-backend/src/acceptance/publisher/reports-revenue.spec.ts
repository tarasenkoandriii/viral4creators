/**
 * AI Publisher — приёмка P-E: выручка только внешняя подтверждённая
 * (AT-CORE-24, отчётная часть; виды оплат на приёме — P-D
 * `leads-payments-kinds.spec`).
 */
import {
  autoRefundRef,
  revenueSummary,
  type PaymentIn,
} from '../../modules/publisher/reports/metrics/economics';
import { randomUUID } from 'crypto';
import { ciDescribe } from '../../prisma/ci-describe.testing';
import { PubDb, connectOwner } from '../../prisma/publisher-schema.testing';
import { PubPorts } from '../../modules/publisher/core/ports';
import type { CoreStack } from '../../modules/publisher/core/testing/core-stack.testing';
import { PaymentsService } from '../../modules/publisher/leads/payments.service';
import { leadsStack } from '../../modules/publisher/leads/testing/leads-fixtures.testing';
import { ReportStalenessJob } from '../../modules/publisher/reports/report-jobs';
import { ReportsService } from '../../modules/publisher/reports/reports.service';
import {
  d,
  seedLead,
  seedPilotWorld,
  seedSession,
} from '../../modules/publisher/reports/testing/pilot-world.testing';
import { computeReport } from '../../modules/publisher/reports/metrics/report-compute';
import {
  T72,
  td09Inputs,
} from '../../modules/publisher/reports/testing/td09.testing';

const at = (iso: string) => new Date(iso);
const pay = (over: Partial<PaymentIn>): PaymentIn => ({
  id: 'p',
  prospectId: 'P1',
  leadId: null,
  recordType: 'payment_received',
  payerKind: 'external',
  amountMinor: 10_000n,
  currency: 'UAH',
  status: 'confirmed',
  occurredAt: at('2026-12-01T10:00:00.000Z'),
  confirmedAt: at('2026-12-01T10:00:00.000Z'),
  isNewCustomer: 'yes',
  ...over,
});

describe('[AT-CORE-24] Оплата и внутренний клиент: внутренняя/тестовая оплата — не выручка и не CAC', () => {
  it('только внутренняя и тестовая оплаты + предложение внешнему → выручки нет, «коммерческая валидация не подтверждена»', () => {
    const r = revenueSummary(
      [
        pay({ id: 'int', payerKind: 'internal' }),
        pay({ id: 'test', payerKind: 'test' }),
        pay({ id: 'self', payerKind: 'self' }),
        pay({ id: 'contract', recordType: 'contract_signed' }), // договор — не выручка
        pay({ id: 'pending', status: 'pending', confirmedAt: null }),
      ],
      T72,
    );
    expect(r).toEqual({
      byCurrency: {
        UAH: { receivedMinor: 0n, refundedMinor: 0n, netMinor: 0n },
      },
      externalPayingProspects: 0,
      contractsSigned: 1,
      excludedNonExternal: 3,
      commercialValidation: 'not_confirmed',
    });
  });

  it('подтверждённая внешняя оплата — выручка; подтверждение после снимка в снимок не входит; полный возврат снимает факт покупки', () => {
    const ext = pay({
      id: 'ext',
      amountMinor: 50_000n,
      confirmedAt: at('2026-12-10T12:00:00.000Z'),
    });
    expect(
      revenueSummary([ext], at('2026-12-10T11:59:59.999Z'))
        .commercialValidation,
    ).toBe('not_confirmed');
    expect(revenueSummary([ext], T72)).toMatchObject({
      byCurrency: {
        UAH: { receivedMinor: 50_000n, refundedMinor: 0n, netMinor: 50_000n },
      },
      externalPayingProspects: 1,
      commercialValidation: 'confirmed',
    });
    // Возврат по правилу P-D (`confirmed → refunded` + запись `refund:<id>`
    // с моментом возврата, аудит P-E S1-3).
    const refund = pay({
      id: 'ref',
      recordType: 'refund',
      amountMinor: 50_000n,
      confirmedAt: at('2026-12-20T10:00:00.000Z'),
      paymentRef: autoRefundRef('ext'),
    });
    const refunded = { ...ext, status: 'refunded' as const };
    expect(revenueSummary([refunded, refund], T72)).toMatchObject({
      byCurrency: {
        UAH: { receivedMinor: 50_000n, refundedMinor: 50_000n, netMinor: 0n },
      },
      externalPayingProspects: 0,
      commercialValidation: 'not_confirmed',
    });
    // До возврата (снимок 15.12) покупка была.
    expect(
      revenueSummary([refunded, refund], at('2026-12-15T10:00:00.000Z'))
        .commercialValidation,
    ).toBe('confirmed');
  });

  it('CAC берёт только внешнюю подтверждённую оплату нового связанного проспекта; без неё — не рассчитывается', () => {
    const base = td09Inputs();
    // TD-09: внешняя P1 (новый, связан) + внутренняя P6 + тестовая P5.
    const r = computeReport(base);
    const m = r.metrics as {
      revenue: Record<string, unknown>;
      economics: Record<string, unknown>;
    };
    expect(m.revenue).toEqual({
      byCurrency: {
        UAH: { receivedMinor: '50000', refundedMinor: '0', netMinor: '50000' },
      },
      externalPayingProspects: 1,
      contractsSigned: 0,
      excludedNonExternal: 2,
      commercialValidation: 'confirmed',
    });
    expect(m.economics.newPayingLinked).toBe(1);
    // Без внешней — только внутренняя и тестовая: CAC «не рассчитывается», а не 0, и валидации нет.
    const noExt = computeReport({
      ...base,
      payments: base.payments.filter((p) => p.payerKind !== 'external'),
    });
    const n = noExt.metrics as {
      revenue: Record<string, unknown>;
      economics: Record<string, { kind: string; reason?: string }>;
    };
    expect(n.revenue.commercialValidation).toBe('not_confirmed');
    expect(n.economics.operationalCac).toMatchObject({
      kind: 'not_computable',
      reason: 'zero_denominator',
    });
    // «Новый клиент» неизвестен → подтверждённый CAC не рассчитывается.
    const unknownNew = computeReport({
      ...base,
      payments: base.payments.map((p) =>
        p.payerKind === 'external'
          ? { ...p, isNewCustomer: 'unknown' as const }
          : p,
      ),
    });
    expect(
      (unknownNew.metrics as { economics: Record<string, unknown> }).economics
        .operationalCac,
    ).toMatchObject({
      kind: 'not_computable',
      reason: 'new_customer_unknown',
    });
  });

  it('возврат статусом refunded: без записи возврата — не выручка ни на каком снимке; с записью — до момента возврата выручка, после — нет; частичный возврат записью — нетто', () => {
    const ext = pay({
      id: 'ext',
      amountMinor: 50_000n,
      confirmedAt: at('2026-12-10T12:00:00.000Z'),
    });
    const refundedNoRecord = { ...ext, status: 'refunded' as const };
    // Проба аудита P3: статус refunded без записи → раньше «confirmed».
    for (const snap of [at('2026-12-15T10:00:00.000Z'), T72]) {
      expect(revenueSummary([refundedNoRecord], snap)).toMatchObject({
        byCurrency: {
          UAH: { receivedMinor: 50_000n, refundedMinor: 50_000n, netMinor: 0n },
        },
        externalPayingProspects: 0,
        commercialValidation: 'not_confirmed',
      });
    }
    // Частичный возврат 200,00 отдельной записью (без связи) у подтверждённой оплаты.
    const partial = pay({
      id: 'part',
      recordType: 'refund',
      amountMinor: 20_000n,
      confirmedAt: at('2026-12-12T10:00:00.000Z'),
      paymentRef: 'RF-2026-12',
    });
    expect(revenueSummary([ext, partial], T72)).toMatchObject({
      byCurrency: {
        UAH: {
          receivedMinor: 50_000n,
          refundedMinor: 20_000n,
          netMinor: 30_000n,
        },
      },
      externalPayingProspects: 1,
      commercialValidation: 'confirmed',
    });
    // CAC: возвращённая к снимку оплата — не новый оплативший.
    const base = td09Inputs();
    const refundedPay = base.payments.map((p) =>
      p.id === 'pay_ext' ? { ...p, status: 'refunded' as const } : p,
    );
    const autoRec = {
      ...base.payments[0],
      id: 'pay_ext_refund',
      recordType: 'refund' as const,
      isNewCustomer: 'no' as const,
      occurredAt: at('2026-12-20T10:00:00.000Z'),
      confirmedAt: at('2026-12-20T10:00:00.000Z'),
      paymentRef: autoRefundRef('pay_ext'),
    };
    const cac = (payments: PaymentIn[], snap = T72) =>
      computeReport(td09Inputs({ payments, snapshotAt: snap })).metrics as {
        economics: { newPayingLinked: number; operationalCac: unknown };
        revenue: { commercialValidation: string };
      };
    expect(cac(refundedPay).economics.newPayingLinked).toBe(0);
    expect(cac(refundedPay).economics.operationalCac).toMatchObject({
      kind: 'not_computable',
      reason: 'zero_denominator',
    });
    expect(cac([...refundedPay, autoRec]).economics.newPayingLinked).toBe(0);
    // Снимок 15.12 — до возврата 20.12: оплата ещё была.
    const before = cac(
      [...refundedPay, autoRec],
      at('2026-12-15T10:00:00.000Z'),
    );
    expect(before.economics.newPayingLinked).toBe(1);
    expect(before.revenue.commercialValidation).toBe('confirmed');
  });

  it('проспект, позже помеченный командой/партнёром, — его оплата не внешняя выручка и не CAC на снимке', () => {
    const base = td09Inputs();
    const r = computeReport({
      ...base,
      prospects: base.prospects.map((p) =>
        p.id === 'P1' ? { ...p, isTeamOrPartner: true } : p,
      ),
    });
    const m = r.metrics as {
      revenue: Record<string, unknown>;
      economics: Record<string, unknown>;
    };
    expect(m.revenue).toMatchObject({
      externalPayingProspects: 0,
      excludedNonExternal: 3,
      commercialValidation: 'not_confirmed',
    });
    expect(m.economics.newPayingLinked).toBe(0);
  });
});

ciDescribe(
  '[AT-CORE-24] Возврат штатным путём P-D (confirmed → refunded): запись возврата, выручка и CAC снимка, наследник по поздней оплате',
  () => {
    let st: CoreStack;
    let owner: Awaited<ReturnType<typeof connectOwner>>;
    let raw: PubDb;
    beforeAll(async () => {
      st = await leadsStack();
      owner = await connectOwner();
      raw = new PubDb(owner);
    });
    afterAll(async () => {
      await owner?.end();
      await st?.close();
    });

    it('возврат пишет refund:<id> с моментом возврата; снимок до возврата — выручка, наследник после — «не подтверждено», CAC без оплаты', async () => {
      const { w } = await seedPilotWorld(raw);
      const product = { id: w.productId, accountId: w.accountId };
      const ref = await seedSession(raw, w, d('2026-01-20T10:00:00Z'));
      // Ранее не платил — оплата будет «новый клиент» (CAC).
      const pros = await raw.prospect(w, { priorExternalPayment: 'no' });
      const { lead, prospect } = await seedLead(raw, w, {
        sessionRef: ref,
        receivedAt: d('2026-01-20T11:00:00Z'),
        qualifiedAt: d('2026-01-21T10:00:00Z'),
        prospect: pros,
      });
      const payments = st.mod.get(PaymentsService);
      const tx = <T>(fn: (t: never) => Promise<T>) =>
        st.db.forAccount(w.accountId).$transaction(fn as never) as Promise<T>;
      const created = await tx((t) =>
        payments.create(
          t,
          product,
          {
            prospectId: prospect,
            leadId: lead,
            recordType: 'payment_received',
            payerKind: 'external',
            amountMinor: '50000',
            currency: 'UAH',
            occurredAt: '2026-02-10T10:00:00.000Z',
            paymentRef: `INV-${randomUUID().slice(0, 8)}`,
          },
          randomUUID(),
          'member:m1',
        ),
      );
      const confirmedAt = new Date(Date.now() - 60_000);
      await tx((t) =>
        payments.transition(
          t,
          product,
          created.view.id,
          'confirmed',
          {},
          'member:m1',
          confirmedAt,
        ),
      );
      const reports = new ReportsService();
      const d72 = await tx((t) =>
        reports.create(t, product, { kind: 'd72' }, 'member:m1', new Date()),
      );
      const m0 = d72.row.metrics as {
        revenue: { commercialValidation: string };
        economics: { newPayingLinked: number };
      };
      expect(m0.revenue.commercialValidation).toBe('confirmed');
      expect(m0.economics.newPayingLinked).toBe(1);
      // Возврат: статус refunded + запись refund с моментом возврата.
      const refundAt = new Date(Date.now() + 1000);
      await tx((t) =>
        payments.transition(
          t,
          product,
          created.view.id,
          'refunded',
          {},
          'member:m1',
          refundAt,
        ),
      );
      const rec = await st.prisma.pubPayment.findFirstOrThrow({
        where: {
          productId: w.productId,
          paymentRef: autoRefundRef(created.view.id),
        },
      });
      expect(rec).toMatchObject({
        recordType: 'refund',
        payerKind: 'external',
        amountMinor: 50_000n,
        status: 'confirmed',
        confirmedAt: refundAt,
        prospectId: prospect,
      });
      // report-staleness видит возврат после снимка → наследник late_payment.
      const job = new ReportStalenessJob(st.db, reports, st.mod.get(PubPorts));
      const out = await job.run({
        now: new Date(Date.now() + 2000),
        scope: { siteIds: [w.siteId] },
        deadline: new Date(Date.now() + 30_000),
      });
      expect(out.details).toMatchObject({ successors: 1 });
      const heir = await st.prisma.pubReport.findFirstOrThrow({
        where: { supersedesReportId: d72.row.id },
      });
      expect(heir.recomputeReason).toBe('late_payment');
      const m1 = heir.metrics as {
        revenue: {
          commercialValidation: string;
          byCurrency: Record<string, Record<string, string>>;
        };
        economics: { newPayingLinked: number };
      };
      expect(m1.revenue.commercialValidation).toBe('not_confirmed');
      expect(m1.revenue.byCurrency.UAH).toEqual({
        receivedMinor: '50000',
        refundedMinor: '50000',
        netMinor: '0',
      });
      expect(m1.economics.newPayingLinked).toBe(0);
      // Исходный снимок — прежний (неизменяем).
      const again = await st.prisma.pubReport.findUniqueOrThrow({
        where: { id: d72.row.id },
      });
      expect(again.metrics).toEqual(d72.row.metrics);
    });
  },
);
