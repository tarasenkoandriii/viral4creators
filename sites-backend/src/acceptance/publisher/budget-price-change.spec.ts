/**
 * [AT-F12-02, S0-1] Правка цены после согласования и резерва (P-C,
 * проектный документ §6.4, §7.2; ТЗ §13 «версия и площадка согласованы →
 * актуальная цена подтверждена → деньги зарезервированы → оформлен заказ»):
 *  - любая правка цены после согласования отвязывает его (статус закупки
 *    тот же, `approvalId = null`); заказ, ожидание публикации и оплата —
 *    409 `PUB_APPROVAL_STALE {price_changed}` до повторного согласования;
 *  - повторное согласование PO выравнивает обязательство по новой цене в
 *    той же операции (рост — по остатку бюджета, снижение — освобождает);
 *  - цена выше `perPurchaseMax` — 409 `PUB_BUDGET_INSUFFICIENT
 *    {per_purchase_cap}` и при предложении, и при правке;
 *  - площадка, снятая с проверки после резерва, заказа не допускает (S3-4).
 */
import { ciDescribe } from '../../prisma/ci-describe.testing';
import {
  apiAs,
  distStack,
  limitCounters,
  seedTd08,
  type DistStack,
  type Td08,
} from '../../modules/publisher/distribution/testing/td08.testing';

jest.setTimeout(180_000);

ciDescribe(
  '[AT-F12-02] цена после согласования/резерва — повторное согласование',
  () => {
    let s: DistStack;
    beforeAll(async () => {
      s = await distStack();
    });
    afterAll(async () => {
      await s.close();
    });

    /** Закупка 500 грн: предложена, согласована (max), зарезервирована. */
    async function reserved500(w: Td08, maxMinor: string) {
      const srv = s.app!.getHttpServer();
      const op = apiAs(srv, w.acc.accountId, w.team.operator);
      const po = apiAs(srv, w.acc.accountId, w.team.product_owner);
      const P = `/publisher/products/${w.product.id}`;
      const pl = (
        await op.post(`${P}/placements`, {
          venueId: w.venueId,
          versionId: w.versionId,
          price: { currency: 'UAH', baseMinor: '50000', feesMinor: '0' },
          priceSource: 'Прайс майданчика',
          terms: 'Публікація протягом 5 днів',
        })
      ).body.data;
      const ap = await po.post(`${P}/placements/${pl.id}/approve`, {
        maxAmountMinor: maxMinor,
        currency: 'UAH',
        versionHash: w.versionHash,
        priceSnapshotHash: pl.priceSnapshotHash,
        expectedRevision: pl.revision,
      });
      expect(ap.status).toBe(200);
      const rs = await op.post(`${P}/placements/${pl.id}/reserve`, {
        expectedRevision: ap.body.data.revision,
      });
      expect(rs.status).toBe(200);
      return { op, po, P, pl: rs.body.data };
    }

    it.each([
      ['500 → 1 900 (max 500)', '50000', '190000', '190000'],
      [
        '500 → 1 400 (max 1 500, в пределах максимума)',
        '150000',
        '140000',
        '150000',
      ],
    ])(
      '%s после резерва: заказ 409 STALE, оплата 409; повторное согласование → обязательство = новой цене → заказ 200',
      async (_name, max0, newTotal, max1) => {
        const w = await seedTd08(s.prisma, s.budget);
        const { op, po, P, pl } = await reserved500(w, max0);
        expect((await op.get(`${P}/budget`)).body.data).toMatchObject({
          openCommitment: '50000',
          available: '750000',
        });
        const up = await op.patch(`${P}/placements/${pl.id}`, {
          price: { currency: 'UAH', baseMinor: newTotal, feesMinor: '0' },
          expectedRevision: pl.revision,
        });
        expect(up.status).toBe(200);
        expect(up.body.data).toMatchObject({
          status: 'budget_reserved',
          totalPriceMinor: newTotal,
          approvalId: null,
        });
        const ord = await op.post(`${P}/placements/${pl.id}/order`, {
          externalOrderId: 'ORD-S0',
          expectedRevision: up.body.data.revision,
        });
        expect(ord.status).toBe(409);
        expect(ord.body.error).toMatchObject({
          code: 'PUB_APPROVAL_STALE',
          details: { reason: 'price_changed' },
        });
        const pay = await op.post(`${P}/expenses/${pl.expenseId}/entries`, {
          kind: 'pay',
          amountMinor: '50000',
          status: 'confirmed',
          externalRef: 'PAY-S0',
        });
        expect(pay.status).toBe(409);
        expect(pay.body.error.code).toBe('PUB_APPROVAL_STALE');
        // Обязательство всё ещё старое — «лишнего» остатка под другую закупку
        // нет: доступно ровно столько, сколько было.
        expect((await op.get(`${P}/budget`)).body.data).toMatchObject({
          openCommitment: '50000',
          available: '750000',
        });

        const re = await po.post(`${P}/placements/${pl.id}/approve`, {
          maxAmountMinor: max1,
          currency: 'UAH',
          versionHash: w.versionHash,
          priceSnapshotHash: up.body.data.priceSnapshotHash,
          expectedRevision: up.body.data.revision,
        });
        expect(re.status).toBe(200);
        expect(re.body.data.status).toBe('budget_reserved');
        expect(re.body.data.approvalId).toEqual(expect.any(String));
        const e = (await op.get(`${P}/expenses/${pl.expenseId}`)).body.data;
        expect(e.amountTotalMinor).toBe(newTotal);
        const total = BigInt(newTotal);
        expect((await op.get(`${P}/budget`)).body.data).toMatchObject({
          openCommitment: newTotal,
          available: String(800_000n - total),
        });
        expect(await limitCounters(s.prisma, w.product.id)).toMatchObject({
          openCommitMinor: total,
          usedPlacementsMinor: total,
        });
        const ok = await op.post(`${P}/placements/${pl.id}/order`, {
          externalOrderId: 'ORD-S0',
          expectedRevision: re.body.data.revision,
        });
        expect(ok.status).toBe(200);
        expect(ok.body.data.status).toBe('ordered');
      },
    );

    it('снижение цены после заказа: ожидание публикации 409 до повторного согласования; согласование освобождает разницу', async () => {
      const w = await seedTd08(s.prisma, s.budget);
      const { op, po, P, pl } = await reserved500(w, '50000');
      let cur = (
        await op.post(`${P}/placements/${pl.id}/order`, {
          externalOrderId: 'ORD-DOWN',
          expectedRevision: pl.revision,
        })
      ).body.data;
      expect(cur.status).toBe('ordered');
      const down = await op.patch(`${P}/placements/${pl.id}`, {
        price: { currency: 'UAH', baseMinor: '40000', feesMinor: '0' },
        expectedRevision: cur.revision,
      });
      expect(down.status).toBe(200);
      const due = new Date(Date.now() + 5 * 86_400_000).toISOString();
      const wait = await op.post(`${P}/placements/${pl.id}/publication`, {
        publishDueAt: due,
        expectedRevision: down.body.data.revision,
      });
      expect(wait.status).toBe(409);
      expect(wait.body.error.code).toBe('PUB_APPROVAL_STALE');
      const re = await po.post(`${P}/placements/${pl.id}/approve`, {
        maxAmountMinor: '40000',
        currency: 'UAH',
        versionHash: w.versionHash,
        priceSnapshotHash: down.body.data.priceSnapshotHash,
        expectedRevision: down.body.data.revision,
      });
      expect(re.status).toBe(200);
      expect((await op.get(`${P}/budget`)).body.data).toMatchObject({
        openCommitment: '40000',
        available: '760000',
      });
      cur = (
        await op.post(`${P}/placements/${pl.id}/publication`, {
          publishDueAt: due,
          expectedRevision: re.body.data.revision,
        })
      ).body.data;
      expect(cur.status).toBe('publication_pending');
    });

    it('цена выше perPurchaseMax (2 000): предложение и правка — 409 per_purchase_cap', async () => {
      const w = await seedTd08(s.prisma, s.budget);
      const { op, P, pl } = await reserved500(w, '50000');
      const up = await op.patch(`${P}/placements/${pl.id}`, {
        price: { currency: 'UAH', baseMinor: '200000', feesMinor: '100' },
        expectedRevision: pl.revision,
      });
      expect(up.status).toBe(409);
      expect(up.body.error).toMatchObject({
        code: 'PUB_BUDGET_INSUFFICIENT',
        details: { reason: 'per_purchase_cap', requested: '200100' },
      });
      const w2 = await seedTd08(s.prisma, s.budget);
      const op2 = apiAs(
        s.app!.getHttpServer(),
        w2.acc.accountId,
        w2.team.operator,
      );
      const big = await op2.post(
        `/publisher/products/${w2.product.id}/placements`,
        {
          venueId: w2.venueId,
          versionId: w2.versionId,
          price: { currency: 'UAH', baseMinor: '210000', feesMinor: '0' },
          priceSource: 'Прайс',
          terms: 'Умови',
        },
      );
      expect(big.status).toBe(409);
      expect(big.body.error.details.reason).toBe('per_purchase_cap');
    });

    it('площадку сняли с проверки после резерва — заказ 409 PUB_GATE_CLOSED (venue)', async () => {
      const w = await seedTd08(s.prisma, s.budget);
      const { op, P, pl } = await reserved500(w, '50000');
      await s.prisma.pubVenue.update({
        where: { id: w.venueId },
        data: { status: 'rejected', rejectReason: 'Фейкова розсилка' },
      });
      const ord = await op.post(`${P}/placements/${pl.id}/order`, {
        externalOrderId: 'ORD-V',
        expectedRevision: pl.revision,
      });
      expect(ord.status).toBe(409);
      expect(ord.body.error).toMatchObject({
        code: 'PUB_GATE_CLOSED',
        details: {
          missing: [{ kind: 'evidence', key: 'venue', detail: 'rejected' }],
        },
      });
    });
  },
);
