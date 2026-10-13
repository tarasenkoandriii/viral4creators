/**
 * [AT-CORE-15] Неизвестная оплата (P-C, проектный документ §6.4, §7.3):
 * поставщик не вернул понятный статус — запись `unknown` удерживает
 * обязательство (open не уменьшается, net_paid не растёт); повторная
 * оплата и повторный заказ — `PUB_RECONCILE_REQUIRED`; закупки продукта
 * закрыты гейтом (`reconcile`); статус меняет ответственный сверкой с
 * документом (confirmed — перенос в факт, void — оплаты не было);
 * корректировка обязательства (любого знака) до сверки — тоже
 * `PUB_RECONCILE_REQUIRED` (S1-1).
 */
import { ciDescribe } from '../../prisma/ci-describe.testing';
import { PubError } from '../../modules/publisher/core/errors';
import type { PubTx } from '../../modules/publisher/core/ports';
import { budgetFn } from '../../modules/publisher/distribution/budget-fn';
import {
  apiAs,
  approvedPlacementDirect,
  distStack,
  limitCounters,
  opKey,
  seedTd08,
  type DistStack,
} from '../../modules/publisher/distribution/testing/td08.testing';

jest.setTimeout(120_000);

ciDescribe(
  '[AT-CORE-15] неизвестная оплата — удержание обязательства и сверка',
  () => {
    let s: DistStack;
    beforeAll(async () => {
      s = await distStack();
    });
    afterAll(async () => {
      await s.close();
    });

    async function reserved() {
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
      const rs = await op.post(`${P}/placements/${x.placementId}/reserve`, {
        expectedRevision: x.revision,
      });
      expect(rs.status).toBe(200);
      return { w, x, op, P, expenseId: rs.body.data.expenseId as string };
    }

    it('unknown удерживает обязательство; повтор оплаты и заказ — PUB_RECONCILE_REQUIRED; гейт закупок закрыт; сверка confirmed с документом', async () => {
      const { w, x, op, P, expenseId } = await reserved();
      const unk = await op.post(`${P}/expenses/${expenseId}/entries`, {
        kind: 'pay',
        amountMinor: '100000',
        status: 'unknown',
        externalRef: 'PSP-42',
        note: 'Платіжний сервіс не повернув статус',
      });
      expect(unk.status).toBe(201);
      expect(unk.body.data).toMatchObject({
        reconcileRequired: true,
        paymentStatus: 'unknown',
        paidMinor: '0',
        openCommitmentMinor: '100000',
      });
      const entryId = unk.body.data.entries.find(
        (e: { kind: string }) => e.kind === 'pay',
      ).id;
      expect(await limitCounters(s.prisma, w.product.id)).toMatchObject({
        netPaidMinor: 0n,
        openCommitMinor: 100_000n,
      });
      expect(
        (await op.get(`${P}/placements/${x.placementId}`)).body.data
          .paymentStatus,
      ).toBe('unknown');

      const rePay = await op.post(`${P}/expenses/${expenseId}/entries`, {
        kind: 'pay',
        amountMinor: '100000',
        status: 'confirmed',
      });
      expect(rePay.body.error.code).toBe('PUB_RECONCILE_REQUIRED');
      const pl = (await op.get(`${P}/placements/${x.placementId}`)).body.data;
      const order = await op.post(`${P}/placements/${x.placementId}/order`, {
        externalOrderId: 'ORD-9',
        expectedRevision: pl.revision,
      });
      expect(order.status).toBe(409);
      expect(order.body.error.code).toBe('PUB_RECONCILE_REQUIRED');
      const gates = (await op.get(`${P}/gates`)).body.data;
      expect(gates.purchases.open).toBe(false);
      expect(gates.purchases.missing).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'reconcile' }),
        ]),
      );

      const noDoc = await op.post(
        `${P}/expenses/${expenseId}/entries/${entryId}/reconcile`,
        {
          status: 'confirmed',
        },
      );
      expect(noDoc.status).toBe(400);
      const viewer = apiAs(
        s.app!.getHttpServer(),
        w.acc.accountId,
        w.team.viewer,
      );
      const byViewer = await viewer.post(
        `${P}/expenses/${expenseId}/entries/${entryId}/reconcile`,
        { status: 'confirmed', document: 'Виписка банку' },
      );
      expect(byViewer.status).toBe(403);
      const rec = await op.post(
        `${P}/expenses/${expenseId}/entries/${entryId}/reconcile`,
        {
          status: 'confirmed',
          document: 'Виписка банку за 13 жовтня',
        },
      );
      expect(rec.status).toBe(200);
      expect(rec.body.data).toMatchObject({
        reconcileRequired: false,
        paymentStatus: 'paid',
        paidMinor: '100000',
        openCommitmentMinor: '0',
      });
      const entry = rec.body.data.entries.find(
        (e: { id: string }) => e.id === entryId,
      );
      expect(entry).toMatchObject({
        status: 'confirmed',
        confirmedBy: `member:${w.team.operator.memberId}`,
      });
      expect(await limitCounters(s.prisma, w.product.id)).toMatchObject({
        netPaidMinor: 100_000n,
        openCommitMinor: 0n,
      });
      const audit = await s.prisma.pubAuditEvent.findFirst({
        where: {
          productId: w.product.id,
          objectId: entryId,
          action: 'resolve',
        },
      });
      expect(audit?.meta).toMatchObject({
        documentRef: 'Виписка банку за 13 жовтня',
      });
      // Повторная сверка той же записи — переход уже невозможен.
      const again = await op.post(
        `${P}/expenses/${expenseId}/entries/${entryId}/reconcile`,
        {
          status: 'void',
          document: 'Помилка',
        },
      );
      expect(again.body.error.code).toBe('PUB_TRANSITION_INVALID');
      // Теперь заказ проходит.
      const pl2 = (await op.get(`${P}/placements/${x.placementId}`)).body.data;
      expect(
        (
          await op.post(`${P}/placements/${x.placementId}/order`, {
            externalOrderId: 'ORD-9',
            expectedRevision: pl2.revision,
          })
        ).status,
      ).toBe(200);
    });

    it('сверка void: оплаты не было — обязательство остаётся открытым, статус unpaid, новая оплата снова возможна', async () => {
      const { w, op, P, expenseId } = await reserved();
      const pend = await op.post(`${P}/expenses/${expenseId}/entries`, {
        kind: 'pay',
        amountMinor: '100000',
        status: 'pending',
      });
      expect(pend.body.data.paymentStatus).toBe('pending');
      const entryId = pend.body.data.entries.find(
        (e: { kind: string }) => e.kind === 'pay',
      ).id;
      const v = await op.post(
        `${P}/expenses/${expenseId}/entries/${entryId}/reconcile`,
        {
          status: 'void',
          document: 'Відповідь банку: платіж не проведено',
        },
      );
      expect(v.status).toBe(200);
      expect(v.body.data).toMatchObject({
        reconcileRequired: false,
        paymentStatus: 'unpaid',
        openCommitmentMinor: '100000',
      });
      expect(await limitCounters(s.prisma, w.product.id)).toMatchObject({
        netPaidMinor: 0n,
        openCommitMinor: 100_000n,
      });
      const pay = await op.post(`${P}/expenses/${expenseId}/entries`, {
        kind: 'pay',
        amountMinor: '40000',
        status: 'confirmed',
        externalRef: 'PAY-1',
      });
      expect(pay.status).toBe(201);
      // Частичная оплата: ждём доплату (§6.4).
      expect(pay.body.data).toMatchObject({
        paymentStatus: 'pending',
        paymentPartial: true,
      });
      // Дубль номера платежа в той же записи — 409, второй расход не создаётся.
      const dup = await op.post(`${P}/expenses/${expenseId}/entries`, {
        kind: 'pay',
        amountMinor: '10000',
        status: 'confirmed',
        externalRef: 'PAY-1',
      });
      expect(dup.status).toBe(409);
      expect(await limitCounters(s.prisma, w.product.id)).toMatchObject({
        netPaidMinor: 40_000n,
        openCommitMinor: 60_000n,
      });
    });

    it('корректировка при unknown-оплате (S1-1): отрицательная и положительная — PUB_RECONCILE_REQUIRED и в API, и в функции; после сверки списанное записывается', async () => {
      const { w, op, P, expenseId } = await reserved();
      await op.post(`${P}/expenses/${expenseId}/entries`, {
        kind: 'pay',
        amountMinor: '100000',
        status: 'unknown',
        externalRef: 'PSP-43',
      });
      const before = (await op.get(`${P}/budget`)).body.data;
      const neg = await op.post(`${P}/expenses/${expenseId}/entries`, {
        kind: 'adjust',
        amountMinor: '-90000',
        note: 'Знижка від майданчика',
      });
      expect(neg.status).toBe(409);
      expect(neg.body.error.code).toBe('PUB_RECONCILE_REQUIRED');
      // То же в самой функции (вызов мимо сервиса).
      const raw = await s.prisma
        .$transaction(async (tx) =>
          budgetFn.adjust(tx as unknown as PubTx, w.ref, {
            expenseId,
            amount: -90_000n,
            note: 'Обхід сервісу',
            approvalId: null,
            priceSnapshotHash: null,
            opKey: opKey(),
            actor: `member:${w.team.operator.memberId}`,
          }),
        )
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(raw).toBeInstanceOf(PubError);
      expect((raw as PubError).code).toBe('PUB_RECONCILE_REQUIRED');
      const tools = (
        await op.post(`${P}/expenses`, {
          category: 'tools',
          description: 'Сервіс розсилки',
          amount: { currency: 'UAH', minor: '30000' },
        })
      ).body.data;
      await op.post(`${P}/expenses/${tools.id}/entries`, {
        kind: 'pay',
        amountMinor: '30000',
        status: 'pending',
      });
      const toolsNeg = await op.post(`${P}/expenses/${tools.id}/entries`, {
        kind: 'adjust',
        amountMinor: '-10000',
        note: 'Знижка сервісу',
      });
      expect(toolsNeg.status).toBe(409);
      expect(toolsNeg.body.error.code).toBe('PUB_RECONCILE_REQUIRED');
      // Остаток не освободился.
      expect((await op.get(`${P}/budget`)).body.data.available).toBe(
        String(BigInt(before.available) - 30_000n),
      );
      // Сверка: деньги на деле ушли — 1 000 записываются полностью.
      const entry = (
        await op.get(`${P}/expenses/${expenseId}`)
      ).body.data.entries.find((e: { kind: string }) => e.kind === 'pay');
      const rec = await op.post(
        `${P}/expenses/${expenseId}/entries/${entry.id}/reconcile`,
        { status: 'confirmed', document: 'Виписка: списано 1 000 грн' },
      );
      expect(rec.status).toBe(200);
      expect(rec.body.data).toMatchObject({
        paidMinor: '100000',
        openCommitmentMinor: '0',
      });
    });
  },
);
