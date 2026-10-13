/**
 * [AT-F12-01] Согласовать, зарезервировать, оплатить и проверить закупку;
 * вектор ТЗ §17 (P-C, проектный документ §9.2, §8.2):
 *   10 000 − 2 000 paid − 1 000 обязательств − 2 000 защищённого резерва =
 *   5 000; delivered_unpaid 400 внутри обязательств не вычитается второй
 *   раз; оплата 1 000 сохраняет 5 000; перевод резерва — решение владельца
 *   и не увеличивает общий лимит.
 * Всё через HTTP-маршруты P-C, на продукте `kind=test` (TD-08).
 */
import { ciDescribe } from '../../prisma/ci-describe.testing';
import {
  apiAs,
  approvedPlacementDirect,
  distStack,
  limitCounters,
  seedTd08,
  type DistStack,
  type Td08,
} from '../../modules/publisher/distribution/testing/td08.testing';

jest.setTimeout(120_000);

ciDescribe(
  '[AT-F12-01] закупка: согласование → резерв → оплата → проверка; вектор ТЗ §17',
  () => {
    let s: DistStack;
    let w: Td08;
    beforeAll(async () => {
      s = await distStack();
      w = await seedTd08(s.prisma, s.budget);
    });
    afterAll(async () => {
      await s.close();
    });

    it('5 000 → 5 000 после оплаты; delivered_unpaid 400 не вычитается дважды; перевод резерва без роста лимита', async () => {
      const srv = s.app!.getHttpServer();
      const P = `/publisher/products/${w.product.id}`;
      const op = apiAs(srv, w.acc.accountId, w.team.operator);
      const po = apiAs(srv, w.acc.accountId, w.team.product_owner);

      const b0 = await op.get(`${P}/budget`);
      expect(b0.status).toBe(200);
      expect(b0.body.data).toMatchObject({
        built: true,
        currency: 'UAH',
        total: '1000000',
        available: '800000',
        protectedReserve: '200000',
      });

      // net_paid 2 000: инструменты 2 000 оплачены.
      const tools = await op.post(`${P}/expenses`, {
        category: 'tools',
        description: 'Хостинг і домен',
        amount: { currency: 'UAH', minor: '200000' },
      });
      expect(tools.status).toBe(201);
      const pay1 = await op.post(
        `${P}/expenses/${tools.body.data.id}/entries`,
        {
          kind: 'pay',
          amountMinor: '200000',
          status: 'confirmed',
          externalRef: 'INV-1',
        },
      );
      expect(pay1.status).toBe(201);

      // open_commitment 1 000: закупка (900 + комиссия 100) согласована и зарезервирована.
      const pl = await op.post(`${P}/placements`, {
        venueId: w.venueId,
        versionId: w.versionId,
        price: { currency: 'UAH', baseMinor: '90000', feesMinor: '10000' },
        priceSource: 'Прайс майданчика',
        terms: 'Публікація протягом 5 днів, позначка «реклама»',
      });
      expect(pl.status).toBe(201);
      expect(pl.body.data).toMatchObject({
        status: 'proposed',
        totalPriceMinor: '100000',
        purchaseSeq: 1,
      });
      expect(pl.body.data.issuedUrl).toContain(
        `utm_content=${pl.body.data.placementCode}`,
      );
      const id = pl.body.data.id;
      const ap = await po.post(`${P}/placements/${id}/approve`, {
        maxAmountMinor: '100000',
        currency: 'UAH',
        versionHash: w.versionHash,
        priceSnapshotHash: pl.body.data.priceSnapshotHash,
        expectedRevision: pl.body.data.revision,
      });
      expect(ap.status).toBe(200);
      expect(ap.body.data.status).toBe('approved');
      const rs = await op.post(`${P}/placements/${id}/reserve`, {
        expectedRevision: ap.body.data.revision,
      });
      expect(rs.status).toBe(200);
      expect(rs.body.data).toMatchObject({ status: 'budget_reserved' });
      const expenseId = rs.body.data.expenseId as string;

      // Оказано 400 из 1 000 (не оплачено). Номер акта с меткой «№» — не
      // контакт (правило P-A1); без метки 7 цифр подряд — отказ с подсказкой.
      const noLabel = await op.post(`${P}/expenses/${expenseId}/entries`, {
        kind: 'deliver',
        amountMinor: '40000',
        sourceDocument: 'Акт 4578123 від 13.10',
      });
      expect(noLabel.status).toBe(400);
      expect(noLabel.body.error.details.fields).toEqual([
        { field: 'sourceDocument', code: 'pii' },
      ]);
      const del = await op.post(`${P}/expenses/${expenseId}/entries`, {
        kind: 'deliver',
        amountMinor: '40000',
        sourceDocument: 'Акт № 4578123 від 13.10',
      });
      expect(del.status).toBe(201);
      expect(del.body.data).toMatchObject({
        openCommitmentMinor: '100000',
        deliveredUnpaidMinor: '40000',
      });

      const b1 = (await op.get(`${P}/budget`)).body.data;
      expect(b1).toMatchObject({
        total: '1000000',
        netPaid: '200000',
        openCommitment: '100000',
        deliveredUnpaid: '40000',
        protectedReserve: '200000',
        available: '500000', // а не 460 000: delivered_unpaid внутри open
      });

      // Оплата обязательства 1 000: перенос в net_paid, остаток прежний.
      const pay2 = await op.post(`${P}/expenses/${expenseId}/entries`, {
        kind: 'pay',
        amountMinor: '100000',
        status: 'confirmed',
        externalRef: 'PAY-77',
      });
      expect(pay2.status).toBe(201);
      const b2 = (await op.get(`${P}/budget`)).body.data;
      expect(b2).toMatchObject({
        netPaid: '300000',
        openCommitment: '0',
        deliveredUnpaid: '0',
        available: '500000',
      });
      expect(b2.cash).toEqual({
        paid: '300000',
        economicDelivered: '40000',
        advances: '260000',
      });
      const placement = (await op.get(`${P}/placements/${id}`)).body.data;
      expect(placement.paymentStatus).toBe('paid');

      // Заказ → ожидание публикации → опубликовано → проверено (URL, UTM, маркировка).
      let rev = placement.revision;
      // Номер заказа поставщика — только цифры (идентификатор, не контакт).
      const ord = await op.post(`${P}/placements/${id}/order`, {
        externalOrderId: '20261013457812',
        expectedRevision: rev,
      });
      expect(ord.status).toBe(200);
      expect(ord.body.data.externalOrderId).toBe('20261013457812');
      rev = ord.body.data.revision;
      const pend = await op.post(`${P}/placements/${id}/publication`, {
        publishDueAt: new Date(Date.now() + 5 * 86_400_000).toISOString(),
        expectedRevision: rev,
      });
      expect(pend.status).toBe(200);
      const pub = await op.post(`${P}/placements/${id}/published`, {
        url: 'https://venue.example/post/1',
        publishedAt: new Date().toISOString(),
        expectedRevision: pend.body.data.revision,
      });
      expect(pub.status).toBe(200);
      const ver = await op.post(`${P}/placements/${id}/verify`, {
        url: 'https://venue.example/post/1',
        linkUrl: pl.body.data.issuedUrl,
        evidenceUrl: 'https://archive.example/venue-post-1.png',
        marking: 'sponsored',
        expectedRevision: pub.body.data.revision,
      });
      expect(ver.status).toBe(200);
      expect(ver.body.data.status).toBe('verified_complete');

      // Перевод резерва: только владелец продукта; лимит 10 000 не растёт.
      const byOp = await op.post(`${P}/budget/reserve-release`, {
        toCategory: 'placements',
        amountMinor: '50000',
        basis: 'Перерозподіл резерву на розміщення',
      });
      expect(byOp.status).toBe(403);
      const rr = await po.post(`${P}/budget/reserve-release`, {
        toCategory: 'placements',
        amountMinor: '50000',
        basis: 'Перерозподіл резерву на розміщення',
      });
      expect(rr.status).toBe(200);
      expect(rr.body.data).toMatchObject({
        total: '1000000',
        protectedReserve: '150000',
        available: '550000',
      });
      expect(rr.body.data.byCategory.placements.limit).toBe('650000');
      expect(rr.body.data.reserveMoves).toHaveLength(1);

      // Счётчики строки лимита = эталон из записей.
      expect(await limitCounters(s.prisma, w.product.id)).toMatchObject({
        totalLimitMinor: 1_000_000n,
        netPaidMinor: 300_000n,
        openCommitMinor: 0n,
        usedPlacementsMinor: 100_000n,
        usedToolsMinor: 200_000n,
        protectedReserveMinor: 150_000n,
      });
    });
  },
);

ciDescribe(
  '[AT-F12-01] предупреждение 80 % и остановка новых обязательств при 100 %',
  () => {
    let s: DistStack;
    beforeAll(async () => {
      s = await distStack();
    });
    afterAll(async () => {
      await s.close();
    });

    it('80 % — warn_80; 100 % — stopped_100 и PUB_BUDGET_STOPPED на новое обязательство; оплата существующего — можно', async () => {
      const w = await seedTd08(s.prisma, s.budget, {
        budget: {
          total: 3_000,
          placements: 1_000,
          tools: 1_000,
          reserve: 1_000,
          perPurchase: 1_000,
        },
      });
      const op = apiAs(
        s.app!.getHttpServer(),
        w.acc.accountId,
        w.team.operator,
      );
      const P = `/publisher/products/${w.product.id}`;
      const t = await op.post(`${P}/expenses`, {
        category: 'tools',
        description: 'Інструменти',
        amount: { currency: 'UAH', minor: '100000' },
      });
      expect(t.status).toBe(201);
      const x = await approvedPlacementDirect(s.prisma, w, {
        seq: 1,
        totalUah: 600,
      });
      await op.post(`${P}/placements/${x.placementId}/reserve`, {
        expectedRevision: x.revision,
      });
      let b = (await op.get(`${P}/budget`)).body.data;
      expect(b).toMatchObject({ usageBp: 8000, warn: true, stopped: false });
      expect(b.warnings).toContain('warn_80');
      const y = await approvedPlacementDirect(s.prisma, w, {
        seq: 1,
        totalUah: 400,
        campaignCode: 'second-campaign',
      });
      const ry = await op.post(`${P}/placements/${y.placementId}/reserve`, {
        expectedRevision: y.revision,
      });
      expect(ry.status).toBe(200);
      b = (await op.get(`${P}/budget`)).body.data;
      expect(b).toMatchObject({
        usageBp: 10000,
        stopped: true,
        available: '0',
      });
      expect(b.warnings).toContain('stopped_100');
      const more = await op.post(`${P}/expenses`, {
        category: 'other',
        description: 'Ще витрата',
        amount: { currency: 'UAH', minor: '100' },
      });
      expect(more.status).toBe(409);
      expect(more.body.error).toMatchObject({
        code: 'PUB_BUDGET_STOPPED',
        details: { reason: 'stopped' },
      });
      const pay = await op.post(`${P}/expenses/${t.body.data.id}/entries`, {
        kind: 'pay',
        amountMinor: '100000',
        status: 'confirmed',
      });
      expect(pay.status).toBe(201);
    });
  },
);
