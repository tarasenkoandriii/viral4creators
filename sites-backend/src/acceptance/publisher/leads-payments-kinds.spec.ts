/**
 * AT-CORE-24, часть P-D (проектный документ §6.5 `pub_payments`; ТЗ §15):
 * виды оплат различаются и хранятся отдельно; выручка — только внешняя
 * подтверждённая полученная оплата; внутренняя, тестовая и собственная —
 * не выручка; без подтверждённой внешней оплаты «коммерческая валидация не
 * подтверждена»; новый клиент — по истории внешних оплат проспекта
 * (неизвестная история — unknown); повтор `paymentRef` вторую оплату не
 * создаёт. Отчёты по выручке и CAC — наборы P-E.
 */
import { randomUUID } from 'crypto';
import * as request from 'supertest';
import { ciDescribe } from '../../prisma/ci-describe.testing';
import {
  asMember,
  type CoreStack,
} from '../../modules/publisher/core/testing/core-stack.testing';
import {
  isRevenuePayment,
  newCustomerOf,
} from '../../modules/publisher/leads/payments.service';
import { LeadEnrichService } from '../../modules/publisher/leads/lead-enrich.job';
import {
  intakeProduct,
  leadBody,
  leadsStack,
  postLead,
  randomIp,
  trustLocalProxy,
  useTestSecrets,
  type IntakeWorld,
} from '../../modules/publisher/leads/testing/leads-fixtures.testing';
import {
  seedMembers,
  type SeededMembers,
} from '../../modules/publisher/testing/fixtures.testing';

jest.setTimeout(120_000);

describe('[AT-CORE-24] Виды оплат: правила (unit)', () => {
  it('выручка — только external + payment_received + confirmed', () => {
    for (const payerKind of ['external', 'internal', 'test', 'self']) {
      for (const recordType of [
        'payment_received',
        'refund',
        'contract_signed',
      ]) {
        for (const status of [
          'pending',
          'confirmed',
          'refunded',
          'cancelled',
        ]) {
          expect(isRevenuePayment({ payerKind, recordType, status })).toBe(
            payerKind === 'external' &&
              recordType === 'payment_received' &&
              status === 'confirmed',
          );
        }
      }
    }
  });
  it('новый клиент: ранняя внешняя оплата → no; история неизвестна → unknown; не внешняя → no', () => {
    const base = { payerKind: 'external', recordType: 'payment_received' };
    expect(
      newCustomerOf({
        ...base,
        earlierExternalPayments: 1,
        priorExternalPayment: 'no',
      }),
    ).toBe('no');
    expect(
      newCustomerOf({
        ...base,
        earlierExternalPayments: 0,
        priorExternalPayment: 'no',
      }),
    ).toBe('yes');
    expect(
      newCustomerOf({
        ...base,
        earlierExternalPayments: 0,
        priorExternalPayment: 'yes',
      }),
    ).toBe('no');
    expect(
      newCustomerOf({
        ...base,
        earlierExternalPayments: 0,
        priorExternalPayment: 'unknown',
      }),
    ).toBe('unknown');
    expect(
      newCustomerOf({
        payerKind: 'internal',
        recordType: 'payment_received',
        earlierExternalPayments: 0,
        priorExternalPayment: 'no',
      }),
    ).toBe('no');
  });
});

ciDescribe(
  '[AT-CORE-24] Оплаты клиентов: внутренняя/тестовая не выручка, внешняя — только подтверждённая',
  () => {
    let s: CoreStack;
    let w: IntakeWorld;
    let team: SeededMembers;
    const srv = () => s.app!.getHttpServer();
    const sa = () => asMember(team.sales.telegramId, w.account.accountId);
    const post = (path: string, body: Record<string, unknown>, as = sa()) =>
      request(srv())
        .post(`/publisher/products/${w.product.id}${path}`)
        .set(as)
        .send({ opKey: randomUUID(), ...body });
    const prospect = async (prior: 'yes' | 'no' | 'unknown') => {
      const r = await post('/prospects', {
        isExternal: true,
        priorExternalPayment: prior,
      });
      expect(r.status).toBe(201);
      return r.body.data.id as string;
    };
    const pay = (
      prospectId: string,
      payerKind: string,
      over: Record<string, unknown> = {},
    ) =>
      post('/payments', {
        prospectId,
        recordType: 'payment_received',
        payerKind,
        amountMinor: '200000',
        currency: 'UAH',
        occurredAt: new Date().toISOString(),
        paymentRef: `INV-${randomUUID().slice(0, 8)}`,
        ...over,
      });

    let restore: Array<() => void>;
    const submitLead = async () => {
      const body = leadBody(w.product.publicKey);
      expect(
        (await postLead(s, body, { origin: w.origin, ip: randomIp() })).status,
      ).toBe(201);
      const l = await s.prisma.pubLead.findFirstOrThrow({
        where: { submissionKey: body.submissionKey },
      });
      await s.mod.get(LeadEnrichService).enrichNow(w.product, l.id);
      return s.prisma.pubLead.findFirstOrThrow({ where: { id: l.id } });
    };

    beforeAll(async () => {
      restore = [useTestSecrets(), trustLocalProxy()];
      s = await leadsStack({ http: true });
      w = await intakeProduct(s, { kind: 'working' });
      team = await seedMembers(s.prisma, w.product, w.account.owner);
    });
    afterAll(async () => {
      restore.forEach((r) => r());
      await s.close();
    });

    it('внутренняя и тестовая оплаты (даже подтверждённые) — не выручка; коммерческая валидация не подтверждена', async () => {
      const p = await prospect('unknown');
      for (const kind of ['internal', 'test', 'self']) {
        const r = await pay(p, kind);
        expect(r.status).toBe(201);
        const c = await post(`/payments/${r.body.data.id}/confirm`, {
          confirmation: 'Акт звірки',
        });
        expect(c.status).toBe(200);
        expect(c.body.data).toMatchObject({
          status: 'confirmed',
          revenue: false,
          isNewCustomer: 'no',
        });
      }
      const list = await request(srv())
        .get(`/publisher/products/${w.product.id}/payments`)
        .set(sa());
      expect(list.status).toBe(200);
      expect(list.body.data.summary).toMatchObject({
        revenueByCurrency: {},
        commercialValidation: false,
      });
    });

    it('внешняя: pending — не выручка; после подтверждения — выручка; новый клиент по истории проспекта', async () => {
      const pNew = await prospect('no');
      const r = await pay(pNew, 'external');
      expect(r.body.data).toMatchObject({ status: 'pending', revenue: false });
      const c = await post(`/payments/${r.body.data.id}/confirm`, {});
      expect(c.body.data).toMatchObject({
        status: 'confirmed',
        revenue: true,
        isNewCustomer: 'yes',
        confirmedBy: `member:${team.sales.memberId}`,
      });
      // Вторая внешняя оплата того же проспекта — уже не новый клиент.
      const r2 = await pay(pNew, 'external');
      expect(
        (await post(`/payments/${r2.body.data.id}/confirm`, {})).body.data
          .isNewCustomer,
      ).toBe('no');
      // Неизвестная история — unknown (основной CAC не подтверждается).
      const pUnknown = await prospect('unknown');
      const r3 = await pay(pUnknown, 'external');
      expect(
        (await post(`/payments/${r3.body.data.id}/confirm`, {})).body.data
          .isNewCustomer,
      ).toBe('unknown');
      const list = await request(srv())
        .get(`/publisher/products/${w.product.id}/payments`)
        .set(sa());
      expect(list.body.data.summary.commercialValidation).toBe(true);
      expect(list.body.data.summary.revenueByCurrency).toEqual({
        UAH: '600000',
      });
    });

    it('возврат подтверждённой — не выручка; отмена ожидающей; переходы вне правил — 409', async () => {
      const p = await prospect('no');
      const r = await pay(p, 'external');
      expect(
        (await post(`/payments/${r.body.data.id}/refund`, {})).status,
      ).toBe(409);
      await post(`/payments/${r.body.data.id}/confirm`, {});
      const rf = await post(`/payments/${r.body.data.id}/refund`, {});
      expect(rf.body.data).toMatchObject({
        status: 'refunded',
        revenue: false,
      });
      const r2 = await pay(p, 'external');
      const cn = await post(`/payments/${r2.body.data.id}/cancel`, {});
      expect(cn.body.data.status).toBe('cancelled');
      expect(
        (await post(`/payments/${r2.body.data.id}/confirm`, {})).status,
      ).toBe(409);
    });

    it('повтор paymentRef — 409 без второй оплаты; повтор opKey — тот же ответ; аналитик — 403; сумма ≤ 0 — 400', async () => {
      const p = await prospect('no');
      const ref = `INV-${randomUUID().slice(0, 8)}`;
      const opKey = randomUUID();
      const body = {
        opKey,
        prospectId: p,
        recordType: 'payment_received',
        payerKind: 'external',
        amountMinor: '1000',
        currency: 'UAH',
        occurredAt: new Date().toISOString(),
        paymentRef: ref,
      };
      const a = await request(srv())
        .post(`/publisher/products/${w.product.id}/payments`)
        .set(sa())
        .send(body);
      const b = await request(srv())
        .post(`/publisher/products/${w.product.id}/payments`)
        .set(sa())
        .send(body);
      expect(a.status).toBe(201);
      expect(b.status).toBe(201);
      expect(b.body.data.id).toBe(a.body.data.id);
      const dup = await pay(p, 'external', { paymentRef: ref });
      expect(dup.status).toBe(409);
      expect(
        await s.prisma.pubPayment.count({
          where: { productId: w.product.id, paymentRef: ref },
        }),
      ).toBe(1);
      expect((await pay(p, 'external', { amountMinor: '0' })).status).toBe(400);
      const an = await pay(p, 'external', {}).set(
        asMember(team.analyst.telegramId, w.account.accountId),
      );
      expect([403]).toContain(an.status);
    });

    it('S3-6: paymentRef с контактом — 400 pii; номер документа с буквами — можно', async () => {
      const p = await prospect('no');
      for (const ref of [
        '+380 67 123 45 67',
        '0671234567',
        'ivan.petrenko@example.com',
        'https://t.me/ivan_petrenko',
      ]) {
        const r = await pay(p, 'external', { paymentRef: ref });
        expect({
          ref,
          status: r.status,
          fields: r.body.error?.details?.fields,
        }).toEqual({
          ref,
          status: 400,
          fields: [{ field: 'paymentRef', code: 'pii' }],
        });
      }
      expect(
        (await pay(p, 'external', { paymentRef: `INV-2026-${Date.now()}` }))
          .status,
      ).toBe(201);
    });

    it('S3-6: заявка оплаты — только своего проспекта; тестовая заявка и команда/партнёр — не external (выручкой не станут)', async () => {
      const lead = await submitLead();
      const own = lead.prospectId as string;
      const other = await prospect('no');
      const wrong = await pay(other, 'external', { leadId: lead.id });
      expect(wrong.status).toBe(400);
      expect(wrong.body.error.details.fields).toEqual([
        { field: 'leadId', code: 'prospect_mismatch' },
      ]);
      expect((await pay(own, 'external', { leadId: lead.id })).status).toBe(
        201,
      );

      const t = await submitLead();
      await s.prisma.pubLead.update({
        where: { id: t.id },
        data: { testFlag: true, testReason: 'team' },
      });
      const ext = await pay(t.prospectId as string, 'external', {
        leadId: t.id,
      });
      expect(ext.status).toBe(400);
      expect(ext.body.error.details.fields).toEqual([
        { field: 'payerKind', code: 'test_lead' },
      ]);
      expect(
        (await pay(t.prospectId as string, 'test', { leadId: t.id })).status,
      ).toBe(201);

      const team2 = await post('/prospects', {
        isExternal: true,
        isTeamOrPartner: true,
        priorExternalPayment: 'no',
      });
      expect(team2.status).toBe(201);
      const tp = await pay(team2.body.data.id, 'external');
      expect(tp.status).toBe(400);
      expect(tp.body.error.details.fields).toEqual([
        { field: 'payerKind', code: 'not_external_prospect' },
      ]);
      expect((await pay(team2.body.data.id, 'internal')).status).toBe(201);
    });
  },
);
