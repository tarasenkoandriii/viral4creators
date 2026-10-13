/**
 * [AT-F12-02] Рост итоговой цены или повтор неизвестной операции (P-C,
 * проектный документ §6.3, §6.4, §7.2, §7.3; F12):
 *  - любая правка цены после согласования → согласование отвязывается,
 *    резерв `PUB_APPROVAL_STALE {price_changed}`, нужно новое согласование
 *    (с ним — проходит);
 *  - истёкшее согласование не разрешает закупку даже при прежней цене —
 *    сервис проверяет срок сам, до крона `approvals-expire-purchase`;
 *  - повтор неизвестной оплаты → `PUB_RECONCILE_REQUIRED`, второй расход
 *    не создаётся; повтор с тем же opKey — тот же ответ;
 *  - положительная корректировка обязательства закупки без нового
 *    согласования отвергнута (`PUB_APPROVAL_REQUIRED`); повторное
 *    согласование после резерва выравнивает обязательство по новой цене
 *    (S0-1, подробно — budget-price-change.spec).
 */
import { randomBytes } from 'crypto';
import * as request from 'supertest';
import { ciDescribe } from '../../prisma/ci-describe.testing';
import { ApprovalsExpirePurchaseJob } from '../../modules/publisher/distribution/approvals-purchase.service';
import {
  apiAs,
  approvedPlacementDirect,
  distStack,
  opKey,
  seedTd08,
  type DistStack,
} from '../../modules/publisher/distribution/testing/td08.testing';

jest.setTimeout(120_000);

ciDescribe(
  '[AT-F12-02] новая цена — новое согласование; неизвестная операция — сверка; истёкшее не работает',
  () => {
    let s: DistStack;
    beforeAll(async () => {
      s = await distStack();
    });
    afterAll(async () => {
      await s.close();
    });

    it('рост цены после согласования → PUB_APPROVAL_STALE; новое согласование → резерв проходит', async () => {
      const w = await seedTd08(s.prisma, s.budget);
      const P = `/publisher/products/${w.product.id}`;
      const op = apiAs(
        s.app!.getHttpServer(),
        w.acc.accountId,
        w.team.operator,
      );
      const po = apiAs(
        s.app!.getHttpServer(),
        w.acc.accountId,
        w.team.product_owner,
      );
      const pl = (
        await op.post(`${P}/placements`, {
          venueId: w.venueId,
          versionId: w.versionId,
          price: { currency: 'UAH', baseMinor: '100000', feesMinor: '0' },
          priceSource: 'Прайс',
          terms: 'Умови',
        })
      ).body.data;
      const ap = (
        await po.post(`${P}/placements/${pl.id}/approve`, {
          maxAmountMinor: '100000',
          currency: 'UAH',
          versionHash: w.versionHash,
          priceSnapshotHash: pl.priceSnapshotHash,
          expectedRevision: pl.revision,
        })
      ).body.data;
      // Поставщик поднял цену: +комиссия 150.
      const up = await op.patch(`${P}/placements/${pl.id}`, {
        price: { currency: 'UAH', baseMinor: '100000', feesMinor: '15000' },
        expectedRevision: ap.revision,
      });
      expect(up.status).toBe(200);
      expect(up.body.data.totalPriceMinor).toBe('115000');
      const r1 = await op.post(`${P}/placements/${pl.id}/reserve`, {
        expectedRevision: up.body.data.revision,
      });
      expect(r1.status).toBe(409);
      expect(r1.body.error.code).toBe('PUB_APPROVAL_STALE');
      // Прежний максимум меньше новой цены — согласовать «по старому» нельзя.
      const low = await po.post(`${P}/placements/${pl.id}/approve`, {
        maxAmountMinor: '100000',
        currency: 'UAH',
        versionHash: w.versionHash,
        priceSnapshotHash: up.body.data.priceSnapshotHash,
        expectedRevision: up.body.data.revision,
      });
      expect(low.status).toBe(400);
      const re = await po.post(`${P}/placements/${pl.id}/approve`, {
        maxAmountMinor: '115000',
        currency: 'UAH',
        versionHash: w.versionHash,
        priceSnapshotHash: up.body.data.priceSnapshotHash,
        expectedRevision: up.body.data.revision,
      });
      expect(re.status).toBe(200);
      expect(re.body.data.approvalId).not.toBe(ap.approvalId);
      expect(
        (await s.prisma.pubApproval.findFirst({ where: { id: ap.approvalId } }))
          ?.status,
      ).toBe('superseded');
      const r2 = await op.post(`${P}/placements/${pl.id}/reserve`, {
        expectedRevision: re.body.data.revision,
      });
      expect(r2.status).toBe(200);
      expect(r2.body.data.status).toBe('budget_reserved');
    });

    it('любая правка цены после согласования (даже в пределах максимума) отвязывает его → PUB_APPROVAL_STALE {price_changed}', async () => {
      const w = await seedTd08(s.prisma, s.budget);
      const P = `/publisher/products/${w.product.id}`;
      const op = apiAs(
        s.app!.getHttpServer(),
        w.acc.accountId,
        w.team.operator,
      );
      const po = apiAs(
        s.app!.getHttpServer(),
        w.acc.accountId,
        w.team.product_owner,
      );
      const pl = (
        await op.post(`${P}/placements`, {
          venueId: w.venueId,
          versionId: w.versionId,
          price: { currency: 'UAH', baseMinor: '100000', feesMinor: '0' },
          priceSource: 'Прайс',
          terms: 'Умови',
        })
      ).body.data;
      const ap = (
        await po.post(`${P}/placements/${pl.id}/approve`, {
          maxAmountMinor: '120000',
          currency: 'UAH',
          versionHash: w.versionHash,
          priceSnapshotHash: pl.priceSnapshotHash,
          expectedRevision: pl.revision,
        })
      ).body.data;
      const up = (
        await op.patch(`${P}/placements/${pl.id}`, {
          price: { currency: 'UAH', baseMinor: '100000', feesMinor: '10000' },
          expectedRevision: ap.revision,
        })
      ).body.data;
      expect(up.approvalId).toBeNull();
      expect(
        (await s.prisma.pubApproval.findFirst({ where: { id: ap.approvalId } }))
          ?.status,
      ).toBe('superseded');
      // Согласовать «по старому снимку» нельзя.
      const oldSnap = await po.post(`${P}/placements/${pl.id}/approve`, {
        maxAmountMinor: '120000',
        currency: 'UAH',
        versionHash: w.versionHash,
        priceSnapshotHash: pl.priceSnapshotHash,
        expectedRevision: up.revision,
      });
      expect(oldSnap.status).toBe(409);
      expect(oldSnap.body.error.code).toBe('PUB_APPROVAL_STALE');
      const r = await op.post(`${P}/placements/${pl.id}/reserve`, {
        expectedRevision: up.revision,
      });
      expect(r.status).toBe(409);
      expect(r.body.error).toMatchObject({
        code: 'PUB_APPROVAL_STALE',
        details: { reason: 'price_changed' },
      });
      // Правка без изменения снимка (источник цены) согласование не трогает.
      const re = (
        await po.post(`${P}/placements/${pl.id}/approve`, {
          maxAmountMinor: '110000',
          currency: 'UAH',
          versionHash: w.versionHash,
          priceSnapshotHash: up.priceSnapshotHash,
          expectedRevision: up.revision,
        })
      ).body.data;
      const src = (
        await op.patch(`${P}/placements/${pl.id}`, {
          priceSource: 'Лист майданчика від 13.10',
          expectedRevision: re.revision,
        })
      ).body.data;
      expect(src.approvalId).toBe(re.approvalId);
    });

    it('истёкшее согласование при прежней цене → PUB_APPROVAL_EXPIRED (и до, и после крона)', async () => {
      const w = await seedTd08(s.prisma, s.budget);
      const x = await approvedPlacementDirect(s.prisma, w, {
        seq: 1,
        totalUah: 1_000,
        expiredAgoHours: 1,
      });
      const P = `/publisher/products/${w.product.id}`;
      const op = apiAs(
        s.app!.getHttpServer(),
        w.acc.accountId,
        w.team.operator,
      );
      const before = await op.post(`${P}/placements/${x.placementId}/reserve`, {
        expectedRevision: x.revision,
      });
      expect(before.status).toBe(409);
      expect(before.body.error.code).toBe('PUB_APPROVAL_EXPIRED');
      const job = s.mod.get(ApprovalsExpirePurchaseJob);
      const res = await job.run({
        now: new Date(),
        scope: { siteIds: [w.product.siteId] },
        deadline: new Date(Date.now() + 30_000),
      });
      expect(res.processed).toBe(1);
      expect(
        (await s.prisma.pubApproval.findFirst({ where: { id: x.approvalId } }))
          ?.status,
      ).toBe('expired');
      const after = await op.post(`${P}/placements/${x.placementId}/reserve`, {
        expectedRevision: x.revision,
      });
      expect(after.body.error.code).toBe('PUB_APPROVAL_EXPIRED');
      expect(
        await s.prisma.pubExpense.count({ where: { productId: w.product.id } }),
      ).toBe(0);
    });

    it('повтор неизвестной оплаты → PUB_RECONCILE_REQUIRED; тот же opKey — тот же ответ; второй расход не создаётся', async () => {
      const w = await seedTd08(s.prisma, s.budget);
      const x = await approvedPlacementDirect(s.prisma, w, {
        seq: 1,
        totalUah: 1_000,
      });
      const srv = s.app!.getHttpServer();
      const op = apiAs(srv, w.acc.accountId, w.team.operator);
      const P = `/publisher/products/${w.product.id}`;
      const rs = await op.post(`${P}/placements/${x.placementId}/reserve`, {
        expectedRevision: x.revision,
      });
      const expenseId = rs.body.data.expenseId;
      const key = opKey();
      const payBody = {
        opKey: key,
        kind: 'pay',
        amountMinor: '100000',
        status: 'unknown',
        externalRef: 'BANK-1',
      };
      const first = await request(srv)
        .post(`${P}/expenses/${expenseId}/entries`)
        .set(op.headers)
        .send(payBody);
      expect(first.status).toBe(201);
      const replay = await request(srv)
        .post(`${P}/expenses/${expenseId}/entries`)
        .set(op.headers)
        .send(payBody);
      expect(replay.status).toBe(201);
      expect(replay.body.data).toEqual(first.body.data);
      const again = await op.post(`${P}/expenses/${expenseId}/entries`, {
        kind: 'pay',
        amountMinor: '100000',
        status: 'confirmed',
        externalRef: 'BANK-2',
      });
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe('PUB_RECONCILE_REQUIRED');
      expect(
        await s.prisma.pubExpenseEntry.count({
          where: { expenseId, kind: 'pay' },
        }),
      ).toBe(1);
      expect(
        await s.prisma.pubExpense.count({ where: { productId: w.product.id } }),
      ).toBe(1);
    });

    it('после резерва: корректировка без согласования отвергнута; повторное согласование новой цены выравнивает обязательство той же операцией', async () => {
      const w = await seedTd08(s.prisma, s.budget);
      const x = await approvedPlacementDirect(s.prisma, w, {
        seq: 1,
        totalUah: 1_000,
        campaignCode: `adj-${randomBytes(3).toString('hex')}`,
      });
      const srv = s.app!.getHttpServer();
      const op = apiAs(srv, w.acc.accountId, w.team.operator);
      const po = apiAs(srv, w.acc.accountId, w.team.product_owner);
      const P = `/publisher/products/${w.product.id}`;
      const rs = await op.post(`${P}/placements/${x.placementId}/reserve`, {
        expectedRevision: x.revision,
      });
      const expenseId = rs.body.data.expenseId;
      const noAppr = await op.post(`${P}/expenses/${expenseId}/entries`, {
        kind: 'adjust',
        amountMinor: '20000',
        note: 'Майданчик додав комісію',
      });
      expect(noAppr.status).toBe(409);
      expect(noAppr.body.error.code).toBe('PUB_APPROVAL_REQUIRED');
      // Снизить обязательство живой закупки записью нельзя — только новой ценой.
      const negLive = await op.post(`${P}/expenses/${expenseId}/entries`, {
        kind: 'adjust',
        amountMinor: '-20000',
        note: 'Знижка',
      });
      expect(negLive.status).toBe(400);
      expect(negLive.body.error.details.fields).toEqual([
        { field: 'amountMinor', code: 'placement_active' },
      ]);
      // Новая цена → повторное согласование → обязательство = цене.
      const up = await op.patch(`${P}/placements/${x.placementId}`, {
        price: { currency: 'UAH', baseMinor: '100000', feesMinor: '20000' },
        expectedRevision: rs.body.data.revision,
      });
      expect(up.status).toBe(200);
      expect(up.body.data.approvalId).toBeNull();
      const re = await po.post(`${P}/placements/${x.placementId}/approve`, {
        maxAmountMinor: '120000',
        currency: 'UAH',
        versionHash: w.versionHash,
        priceSnapshotHash: up.body.data.priceSnapshotHash,
        expectedRevision: up.body.data.revision,
      });
      expect(re.status).toBe(200);
      expect(re.body.data.status).toBe('budget_reserved');
      const e = (await op.get(`${P}/expenses/${expenseId}`)).body.data;
      expect(e).toMatchObject({
        amountTotalMinor: '120000',
        openCommitmentMinor: '120000',
      });
      expect(
        e.entries.filter((x: { kind: string }) => x.kind === 'adjust'),
      ).toEqual([
        expect.objectContaining({ amountMinor: '20000', status: 'confirmed' }),
      ]);
      expect(
        (
          await s.prisma.pubApproval.findFirst({
            where: { id: re.body.data.approvalId },
          })
        )?.status,
      ).toBe('consumed');
      // Израсходованное согласование второй раз не работает.
      const again = await op.post(`${P}/expenses/${expenseId}/entries`, {
        kind: 'adjust',
        amountMinor: '20000',
        note: 'Ще комісія',
        approvalId: re.body.data.approvalId,
      });
      expect(again.status).toBe(409);
    });
  },
);
