/**
 * [AT-CORE-16] Оплачено, но не опубликовано (P-C, проектный документ
 * §7.2, §7.3): оплата остаётся фактом (`paid`), публикация — отдельной
 * машиной (`publication_pending` → `disputed`); у претензии обязательно
 * есть владелец и дата следующего действия; результат трафика не
 * выдумывается (сессий/событий с этим размещением система не создаёт).
 */
import { ciDescribe } from '../../prisma/ci-describe.testing';
import {
  apiAs,
  approvedPlacementDirect,
  distStack,
  seedTd08,
  type DistStack,
} from '../../modules/publisher/distribution/testing/td08.testing';

jest.setTimeout(120_000);

ciDescribe(
  '[AT-CORE-16] оплачено, но не опубликовано — претензия с владельцем и сроком',
  () => {
    let s: DistStack;
    beforeAll(async () => {
      s = await distStack();
    });
    afterAll(async () => {
      await s.close();
    });

    it('paid + publication_pending → disputed (владелец и nextActionAt обязательны); оплата не меняется; трафика нет', async () => {
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
      const pay = await op.post(`${P}/expenses/${pl.expenseId}/entries`, {
        kind: 'pay',
        amountMinor: '100000',
        status: 'confirmed',
        externalRef: 'PAY-16',
      });
      expect(pay.body.data.paymentStatus).toBe('paid');
      pl = (await op.get(`${P}/placements/${x.placementId}`)).body.data;
      pl = (
        await op.post(`${P}/placements/${x.placementId}/order`, {
          externalOrderId: 'ORD-16',
          expectedRevision: pl.revision,
        })
      ).body.data;
      const due = new Date(Date.now() - 2 * 86_400_000).toISOString();
      pl = (
        await op.post(`${P}/placements/${x.placementId}/publication`, {
          publishDueAt: due,
          expectedRevision: pl.revision,
        })
      ).body.data;
      expect(pl).toMatchObject({
        status: 'publication_pending',
        paymentStatus: 'paid',
        publishedAt: null,
      });

      // Без владельца претензии или даты следующего действия — нельзя.
      const noOwner = await op.post(
        `${P}/placements/${x.placementId}/dispute`,
        {
          nextActionAt: new Date(Date.now() + 86_400_000).toISOString(),
          reason: 'Публікацію не виконано у строк',
          expectedRevision: pl.revision,
        },
      );
      expect(noOwner.status).toBe(400);
      expect(noOwner.body.error.details.fields).toEqual(
        expect.arrayContaining([
          { field: 'claimOwnerMemberId', code: 'required' },
        ]),
      );
      const noDate = await op.post(`${P}/placements/${x.placementId}/dispute`, {
        claimOwnerMemberId: w.team.operator.memberId,
        reason: 'Публікацію не виконано у строк',
        expectedRevision: pl.revision,
      });
      expect(noDate.status).toBe(400);
      const stranger = await op.post(
        `${P}/placements/${x.placementId}/dispute`,
        {
          claimOwnerMemberId: 'not-a-member',
          nextActionAt: new Date(Date.now() + 86_400_000).toISOString(),
          reason: 'Публікацію не виконано у строк',
          expectedRevision: pl.revision,
        },
      );
      expect(stranger.status).toBe(400);
      // Участник кабинета без права вести претензии в продукте (аналитик) —
      // не владелец претензии (S3-7).
      const noRole = await op.post(`${P}/placements/${x.placementId}/dispute`, {
        claimOwnerMemberId: w.team.analyst.memberId,
        nextActionAt: new Date(Date.now() + 86_400_000).toISOString(),
        reason: 'Публікацію не виконано у строк',
        expectedRevision: pl.revision,
      });
      expect(noRole.status).toBe(400);
      expect(noRole.body.error.details.fields).toEqual([
        { field: 'claimOwnerMemberId', code: 'no_role' },
      ]);
      // Владелец кабинета — может.
      const byOwnerId = await op.post(
        `${P}/placements/${x.placementId}/dispute`,
        {
          claimOwnerMemberId: w.acc.owner.memberId,
          nextActionAt: new Date(Date.now() + 86_400_000).toISOString(),
          reason: 'Публікацію не виконано у строк',
          expectedRevision: pl.revision,
        },
      );
      expect(byOwnerId.status).toBe(200);
      pl = byOwnerId.body.data;
      // Вернуть ожидание, чтобы дальше открыть претензию оператору.
      pl = (
        await op.post(`${P}/placements/${x.placementId}/dispute/resolve`, {
          to: 'publication_pending',
          reason: 'Майданчик відповів, чекаємо',
          publishDueAt: new Date(Date.now() - 86_400_000).toISOString(),
          expectedRevision: pl.revision,
        })
      ).body.data;

      const next = new Date(Date.now() + 86_400_000).toISOString();
      const d = await op.post(`${P}/placements/${x.placementId}/dispute`, {
        claimOwnerMemberId: w.team.operator.memberId,
        nextActionAt: next,
        reason: 'Публікацію не виконано у строк',
        expectedRevision: pl.revision,
      });
      expect(d.status).toBe(200);
      expect(d.body.data).toMatchObject({
        status: 'disputed',
        claimStatus: 'open',
        claimOwnerMemberId: w.team.operator.memberId,
        nextActionAt: next,
        paymentStatus: 'paid',
        publishedAt: null,
      });
      // Трафик не создаётся: ни сессий, ни событий с этим размещением.
      expect(
        await s.prisma.pubSession.count({
          where: { placementId: x.placementId },
        }),
      ).toBe(0);
      expect(
        await s.prisma.pubEvent.count({
          where: { placementId: x.placementId },
        }),
      ).toBe(0);
      // Оплата — факт: net_paid 1 000, обязательство закрыто.
      const b = (await op.get(`${P}/budget`)).body.data;
      expect(b).toMatchObject({ netPaid: '100000', openCommitment: '0' });

      // Итог претензии: новый срок публикации.
      const r = await op.post(
        `${P}/placements/${x.placementId}/dispute/resolve`,
        {
          to: 'publication_pending',
          reason: 'Майданчик підтвердив нову дату',
          publishDueAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
          expectedRevision: d.body.data.revision,
        },
      );
      expect(r.status).toBe(200);
      expect(r.body.data).toMatchObject({
        status: 'publication_pending',
        claimStatus: 'resolved',
        paymentStatus: 'paid',
      });
      // Аналитик претензию открыть не может (матрица §4.2).
      const an = apiAs(s.app!.getHttpServer(), w.acc.accountId, w.team.analyst);
      const byAnalyst = await an.post(
        `${P}/placements/${x.placementId}/dispute`,
        {
          claimOwnerMemberId: w.team.operator.memberId,
          nextActionAt: next,
          reason: 'Публікацію не виконано у строк',
          expectedRevision: r.body.data.revision,
        },
      );
      expect(byAnalyst.status).toBe(403);
    });
  },
);
