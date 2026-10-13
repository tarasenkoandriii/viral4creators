/**
 * [AT-CORE-17] Отмена и возврат (P-C, проектный документ §7.2, §7.3, §8.2;
 * ТЗ §17): остаток освобождается только по подтверждённой отмене (и только
 * на подтверждённую сумму); фактический расход уменьшается только после
 * подтверждённого возврата — обещание возврата не равно полученным деньгам.
 */
import { randomBytes } from 'crypto';
import { ciDescribe } from '../../prisma/ci-describe.testing';
import {
  apiAs,
  approvedPlacementDirect,
  distStack,
  limitCounters,
  seedTd08,
  type DistStack,
} from '../../modules/publisher/distribution/testing/td08.testing';

jest.setTimeout(120_000);

ciDescribe(
  '[AT-CORE-17] отмена освобождает подтверждённое, возврат — после подтверждения',
  () => {
    let s: DistStack;
    beforeAll(async () => {
      s = await distStack();
    });
    afterAll(async () => {
      await s.close();
    });

    it('отмена неоплаченного заказа: сначала подтверждённые 600 из 1 000 (400 остаются обязательством)', async () => {
      const w = await seedTd08(s.prisma, s.budget);
      const x = await approvedPlacementDirect(s.prisma, w, {
        seq: 1,
        totalUah: 1_000,
      });
      const op = apiAs(
        s.app!.getHttpServer(),
        w.acc.accountId,
        w.team.operator,
      );
      const P = `/publisher/products/${w.product.id}`;
      let pl = (
        await op.post(`${P}/placements/${x.placementId}/reserve`, {
          expectedRevision: x.revision,
        })
      ).body.data;
      pl = (
        await op.post(`${P}/placements/${x.placementId}/order`, {
          externalOrderId: 'ORD-17',
          expectedRevision: pl.revision,
        })
      ).body.data;
      expect((await op.get(`${P}/budget`)).body.data.available).toBe('700000');
      const tooMuch = await op.post(`${P}/placements/${x.placementId}/cancel`, {
        confirmedAmountMinor: '100001',
        document: 'Лист майданчика',
        expectedRevision: pl.revision,
      });
      expect(tooMuch.status).toBe(400);
      const noDoc = await op.post(`${P}/placements/${x.placementId}/cancel`, {
        confirmedAmountMinor: '60000',
        expectedRevision: pl.revision,
      });
      expect(noDoc.status).toBe(400);
      const c = await op.post(`${P}/placements/${x.placementId}/cancel`, {
        confirmedAmountMinor: '60000',
        document: 'Лист майданчика: скасовано 600 грн',
        expectedRevision: pl.revision,
      });
      expect(c.status).toBe(200);
      expect(c.body.data.status).toBe('cancelled');
      const b = (await op.get(`${P}/budget`)).body.data;
      expect(b).toMatchObject({ openCommitment: '40000', available: '760000' });
      expect(await limitCounters(s.prisma, w.product.id)).toMatchObject({
        openCommitMinor: 40_000n,
        usedPlacementsMinor: 40_000n,
      });
      const e = (await op.get(`${P}/expenses/${pl.expenseId}`)).body.data;
      expect(e).toMatchObject({
        cancelledMinor: '60000',
        openCommitmentMinor: '40000',
      });
      // Вторую часть отмены ведёт запись расхода (закупка уже cancelled):
      // по закупке — только машиной закупки.
      const viaEntry = await op.post(`${P}/expenses/${pl.expenseId}/entries`, {
        kind: 'cancel',
        amountMinor: '40000',
      });
      expect(viaEntry.status).toBe(400);
      // Остаток 400 снимает явная отрицательная корректировка с причиной.
      const rest = await op.post(`${P}/expenses/${pl.expenseId}/entries`, {
        kind: 'adjust',
        amountMinor: '-40000',
        note: 'Майданчик підтвердив скасування решти',
      });
      expect(rest.status).toBe(201);
      expect((await op.get(`${P}/budget`)).body.data).toMatchObject({
        openCommitment: '0',
        available: '800000',
      });
    });

    it('отмена при неизвестной оплате — PUB_RECONCILE_REQUIRED (что отменять — неизвестно)', async () => {
      const w = await seedTd08(s.prisma, s.budget);
      const x = await approvedPlacementDirect(s.prisma, w, {
        seq: 1,
        totalUah: 1_000,
      });
      const op = apiAs(
        s.app!.getHttpServer(),
        w.acc.accountId,
        w.team.operator,
      );
      const P = `/publisher/products/${w.product.id}`;
      const pl = (
        await op.post(`${P}/placements/${x.placementId}/reserve`, {
          expectedRevision: x.revision,
        })
      ).body.data;
      await op.post(`${P}/expenses/${pl.expenseId}/entries`, {
        kind: 'pay',
        amountMinor: '100000',
        status: 'unknown',
      });
      const cur = (await op.get(`${P}/placements/${x.placementId}`)).body.data;
      const c = await op.post(`${P}/placements/${x.placementId}/cancel`, {
        confirmedAmountMinor: '100000',
        document: 'Лист',
        expectedRevision: cur.revision,
      });
      expect(c.status).toBe(409);
      expect(c.body.error.code).toBe('PUB_RECONCILE_REQUIRED');
    });

    it('обещанный возврат не меняет net_paid; подтверждённый — меняет (и освобождает остаток)', async () => {
      const w = await seedTd08(s.prisma, s.budget);
      const x = await approvedPlacementDirect(s.prisma, w, {
        seq: 1,
        totalUah: 1_000,
        campaignCode: `rf-${randomBytes(3).toString('hex')}`,
      });
      const op = apiAs(
        s.app!.getHttpServer(),
        w.acc.accountId,
        w.team.operator,
      );
      const P = `/publisher/products/${w.product.id}`;
      const pl = (
        await op.post(`${P}/placements/${x.placementId}/reserve`, {
          expectedRevision: x.revision,
        })
      ).body.data;
      await op.post(`${P}/expenses/${pl.expenseId}/entries`, {
        kind: 'pay',
        amountMinor: '100000',
        status: 'confirmed',
        externalRef: 'PAY-R',
      });
      const before = (await op.get(`${P}/budget`)).body.data;
      expect(before).toMatchObject({ netPaid: '100000', available: '700000' });

      const promised = await op.post(`${P}/expenses/${pl.expenseId}/entries`, {
        kind: 'refund',
        amountMinor: '100000',
        status: 'pending',
        note: 'Майданчик пообіцяв повернути кошти',
      });
      expect(promised.status).toBe(201);
      expect(promised.body.data).toMatchObject({
        refundedMinor: '0',
        paymentStatus: 'paid',
        reconcileRequired: false,
      });
      expect((await op.get(`${P}/budget`)).body.data).toMatchObject({
        netPaid: '100000',
        available: '700000',
      });
      const entryId = promised.body.data.entries.find(
        (e: { kind: string }) => e.kind === 'refund',
      ).id;
      const got = await op.post(
        `${P}/expenses/${pl.expenseId}/entries/${entryId}/reconcile`,
        {
          status: 'confirmed',
          document: 'Виписка: повернення 1 000 грн',
        },
      );
      expect(got.status).toBe(200);
      expect(got.body.data).toMatchObject({
        refundedMinor: '100000',
        paymentStatus: 'refunded',
      });
      expect((await op.get(`${P}/budget`)).body.data).toMatchObject({
        netPaid: '0',
        available: '800000',
      });
      expect(
        (await op.get(`${P}/placements/${x.placementId}`)).body.data
          .paymentStatus,
      ).toBe('refunded');
      expect(await limitCounters(s.prisma, w.product.id)).toMatchObject({
        netPaidMinor: 0n,
        usedPlacementsMinor: 0n,
      });
      // Возврат сверх оплаченного — отказ.
      const over = await op.post(`${P}/expenses/${pl.expenseId}/entries`, {
        kind: 'refund',
        amountMinor: '1',
        status: 'confirmed',
      });
      expect(over.status).toBe(400);
    });

    it.each([
      ['отмена', 'cancel'],
      ['претензия → cancelled', 'dispute'],
    ])(
      'оплаченный заказ (S1-3): %s с подтверждённой суммой 0 → cancelled; возврат — записью refund; следующая закупка кампании предлагается',
      async (_name, path) => {
        const w = await seedTd08(s.prisma, s.budget);
        const x = await approvedPlacementDirect(s.prisma, w, {
          seq: 1,
          totalUah: 1_000,
        });
        const op = apiAs(
          s.app!.getHttpServer(),
          w.acc.accountId,
          w.team.operator,
        );
        const P = `/publisher/products/${w.product.id}`;
        let pl = (
          await op.post(`${P}/placements/${x.placementId}/reserve`, {
            expectedRevision: x.revision,
          })
        ).body.data;
        await op.post(`${P}/expenses/${pl.expenseId}/entries`, {
          kind: 'pay',
          amountMinor: '100000',
          status: 'confirmed',
          externalRef: 'PAY-C0',
        });
        pl = (await op.get(`${P}/placements/${x.placementId}`)).body.data;
        pl = (
          await op.post(`${P}/placements/${x.placementId}/order`, {
            externalOrderId: 'ORD-C0',
            expectedRevision: pl.revision,
          })
        ).body.data;
        // Отрицательная сумма — нет.
        const neg = await op.post(`${P}/placements/${x.placementId}/cancel`, {
          confirmedAmountMinor: '-1',
          document: 'Лист',
          expectedRevision: pl.revision,
        });
        expect(neg.status).toBe(400);
        let done;
        if (path === 'cancel') {
          done = await op.post(`${P}/placements/${x.placementId}/cancel`, {
            confirmedAmountMinor: '0',
            document: 'Лист майданчика: замовлення знято, кошти повернемо',
            expectedRevision: pl.revision,
          });
        } else {
          pl = (
            await op.post(`${P}/placements/${x.placementId}/publication`, {
              publishDueAt: new Date(Date.now() - 86_400_000).toISOString(),
              expectedRevision: pl.revision,
            })
          ).body.data;
          const d = await op.post(`${P}/placements/${x.placementId}/dispute`, {
            claimOwnerMemberId: w.team.operator.memberId,
            nextActionAt: new Date(Date.now() + 86_400_000).toISOString(),
            reason: 'Публікацію не виконано',
            expectedRevision: pl.revision,
          });
          // Без открытой претензии разрешение ответит не 200 (проверка ниже).
          done = await op.post(
            `${P}/placements/${x.placementId}/dispute/resolve`,
            {
              to: 'cancelled',
              reason: 'Майданчик відмовився, кошти повертає',
              confirmedAmountMinor: '0',
              document: 'Лист майданчика: замовлення знято',
              expectedRevision: d.body.data.revision,
            },
          );
        }
        expect(done.status).toBe(200);
        expect(done.body.data).toMatchObject({
          status: 'cancelled',
          paymentStatus: 'paid',
        });
        // Движения нет: оплата — факт, обязательство закрыто.
        expect((await op.get(`${P}/budget`)).body.data).toMatchObject({
          netPaid: '100000',
          openCommitment: '0',
        });
        const back = await op.post(`${P}/expenses/${pl.expenseId}/entries`, {
          kind: 'refund',
          amountMinor: '100000',
          status: 'confirmed',
          externalRef: 'REF-C0',
        });
        expect(back.status).toBe(201);
        expect(
          (await op.get(`${P}/placements/${x.placementId}`)).body.data,
        ).toMatchObject({ status: 'cancelled', paymentStatus: 'refunded' });
        expect((await op.get(`${P}/budget`)).body.data).toMatchObject({
          netPaid: '0',
          available: '800000',
        });
        // Кампания не стоит: следующая закупка предлагается.
        const next = await op.post(`${P}/placements`, {
          venueId: w.venueId,
          versionId: w.versionId,
          price: { currency: 'UAH', baseMinor: '80000', feesMinor: '0' },
          priceSource: 'Прайс майданчика',
          terms: 'Публікація протягом 5 днів',
        });
        expect(next.status).toBe(201);
        expect(next.body.data).toMatchObject({
          status: 'proposed',
          purchaseSeq: 2,
        });
      },
    );
  },
);
