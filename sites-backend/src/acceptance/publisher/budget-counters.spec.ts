/**
 * [AT-F12-01, Р-PUB-C-4] Сверка счётчиков бюджета (P-C, проектный документ
 * §8.2, §15.1):
 *  - S2-1: ежедневная сверка читает строку лимита и записи ОДНИМ снимком —
 *    строка лимита `FOR SHARE` первым оператором; параллельная оплата
 *    (настоящее второе соединение) не даёт ложного расхождения: сверка ждёт
 *    её фиксации и видит согласованные данные;
 *  - S2-4: при уже существующем расхождении (запись мимо функций) новые
 *    обязательства остановлены, а оплата, сверка unknown, отмена, возврат и
 *    «оказано» проходят, если расхождение не меняют; функция, меняющая
 *    расхождение, откатывается; владелец продукта чинит счётчики
 *    пересборкой из записей (маршрут с основанием, аудит), оператор — нет.
 */
import { randomUUID } from 'crypto';
import { Client } from 'pg';
import { ciDescribe } from '../../prisma/ci-describe.testing';
import { pgUrl } from '../../prisma/publisher-schema.testing';
import type { PubTx } from '../../modules/publisher/core/ports';
import { budgetFn } from '../../modules/publisher/distribution/budget-fn';
import { BudgetReconcileJob } from '../../modules/publisher/distribution/budget-reconcile.job';
import {
  apiAs,
  approvedPlacementDirect,
  distStack,
  limitCounters,
  opKey,
  seedTd08,
  seedTz17State,
  type DistStack,
} from '../../modules/publisher/distribution/testing/td08.testing';

jest.setTimeout(180_000);

ciDescribe(
  '[AT-F12-01] сверка счётчиков: снимок, расхождение, пересборка',
  () => {
    let s: DistStack;
    beforeAll(async () => {
      s = await distStack();
    });
    afterAll(async () => {
      jest.restoreAllMocks();
      await s.close();
    });

    it('S2-1: оплата в соседнем соединении фиксируется посреди сверки — сверка ждёт её и расхождения не находит', async () => {
      const w = await seedTd08(s.prisma, s.budget);
      const st = await seedTz17State(s.prisma, w);
      const c1 = new Client({
        connectionString: pgUrl(process.env.SITES_DIRECT_URL as string),
      });
      await c1.connect();
      const job = s.mod.get(BudgetReconcileJob);
      let committed = false;
      const commit = async () => {
        if (committed) return;
        committed = true;
        await c1.query('COMMIT');
      };
      const orig = s.budget.limitRow.bind(s.budget);
      // Инъекция гонки аудита P4: оплата фиксируется сразу после чтения
      // строки лимита сверкой.
      const spy = jest
        .spyOn(s.budget, 'limitRow')
        .mockImplementation(async (tx, id) => {
          const r = await orig(tx, id);
          await commit();
          return r;
        });
      try {
        await c1.query('BEGIN');
        await c1.query(
          `SELECT "sites"."pub_budget_pay"($1, $2, $3, 50000::bigint, 'confirmed', 'PAY-RACE', NULL, NULL, now(), $4, $5)`,
          [
            w.ref.id,
            w.ref.accountId,
            st.p0ExpenseId,
            opKey(),
            `member:${w.team.operator.memberId}`,
          ],
        );
        const run = s.prisma.$transaction(
          (tx) => job.reconcileOne(tx as unknown as PubTx, w.ref, new Date()),
          { timeout: 20_000 },
        );
        await new Promise((r) => setTimeout(r, 700));
        // Сверка стоит на блокировке строки лимита — до чтения счётчиков.
        const waited = !committed;
        await commit();
        const out = await run;
        expect(waited).toBe(true);
        expect(out).toEqual({ productId: w.product.id, ok: true, diff: {} });
      } finally {
        spy.mockRestore();
        await c1.end();
      }
      expect(
        await s.prisma.pubReviewTask.count({
          where: { productId: w.product.id, objectType: 'budget_limit' },
        }),
      ).toBe(0);
      expect(await limitCounters(s.prisma, w.product.id)).toMatchObject({
        netPaidMinor: 250_000n,
        openCommitMinor: 50_000n,
      });
    });

    it('S2-4: при расхождении — новые обязательства стоп, оплата/сверка/отмена/возврат/оказано проходят; пересборка владельцем', async () => {
      const w = await seedTd08(s.prisma, s.budget);
      const srv = s.app!.getHttpServer();
      const op = apiAs(srv, w.acc.accountId, w.team.operator);
      const po = apiAs(srv, w.acc.accountId, w.team.product_owner);
      const P = `/publisher/products/${w.product.id}`;
      const x = await approvedPlacementDirect(s.prisma, w, {
        seq: 1,
        totalUah: 1_000,
      });
      const rs = await op.post(`${P}/placements/${x.placementId}/reserve`, {
        expectedRevision: x.revision,
      });
      expect(rs.status).toBe(200);
      const st = { p0ExpenseId: rs.body.data.expenseId as string };
      await op.post(`${P}/expenses/${st.p0ExpenseId}/entries`, {
        kind: 'deliver',
        amountMinor: '40000',
      });
      const tools = (
        await op.post(`${P}/expenses`, {
          category: 'tools',
          description: 'Сервіс',
          amount: { currency: 'UAH', minor: '50000' },
        })
      ).body.data;
      // Запись оплаты мимо функций: голова и счётчики расходятся с записями.
      await s.prisma.pubExpenseEntry.create({
        data: {
          accountId: w.ref.accountId,
          productId: w.ref.id,
          expenseId: tools.id,
          kind: 'pay',
          amountMinor: 10_000n,
          status: 'confirmed',
          occurredAt: new Date(),
          confirmedAt: new Date(),
          confirmedBy: 'member:x',
          opKey: randomUUID(),
          createdBy: 'member:x',
        },
      });
      const drift0 = await s.prisma.$transaction((tx) =>
        budgetFn.drift(tx as unknown as PubTx, w.ref),
      );
      expect(drift0).toMatch(/^limit=-10000\/10000\/0\/0 heads=/);

      const stop = await op.post(`${P}/expenses`, {
        category: 'other',
        description: 'Нова витрата',
        amount: { currency: 'UAH', minor: '100' },
      });
      expect(stop.status).toBe(409);
      expect(stop.body.error).toMatchObject({
        code: 'PUB_BUDGET_STOPPED',
        details: { reason: 'counters_mismatch' },
      });
      // Деньги, которые уже движутся, записать можно.
      const unk = await op.post(`${P}/expenses/${st.p0ExpenseId}/entries`, {
        kind: 'pay',
        amountMinor: '60000',
        status: 'unknown',
        externalRef: 'PSP-D',
      });
      expect(unk.status).toBe(201);
      const unkId = unk.body.data.entries.find(
        (e: { kind: string; status: string }) =>
          e.kind === 'pay' && e.status === 'unknown',
      ).id;
      const rec = await op.post(
        `${P}/expenses/${st.p0ExpenseId}/entries/${unkId}/reconcile`,
        { status: 'confirmed', document: 'Виписка: списано 600 грн' },
      );
      expect(rec.status).toBe(200);
      const deliver = await op.post(`${P}/expenses/${st.p0ExpenseId}/entries`, {
        kind: 'deliver',
        amountMinor: '20000',
      });
      expect(deliver.status).toBe(201);
      const refund = await op.post(`${P}/expenses/${st.p0ExpenseId}/entries`, {
        kind: 'refund',
        amountMinor: '10000',
        status: 'confirmed',
        externalRef: 'REF-D',
      });
      expect(refund.status).toBe(201);
      const cancel = await op.post(`${P}/expenses/${tools.id}/entries`, {
        kind: 'cancel',
        amountMinor: '5000',
      });
      expect(cancel.status).toBe(201);
      // Расхождение не изменилось ни одной из операций.
      expect(
        await s.prisma.$transaction((tx) =>
          budgetFn.drift(tx as unknown as PubTx, w.ref),
        ),
      ).toBe(drift0);
      // Функция, которая МЕНЯЕТ существующее расхождение, откатывается.
      const changed = await s.prisma
        .$transaction(async (raw) => {
          await raw.$executeRaw`UPDATE "sites"."pub_budget_limits" SET "netPaidMinor" = "netPaidMinor" + 1 WHERE "productId" = ${w.ref.id}`;
          await raw.$queryRaw`SELECT "sites"."pub_budget_verify_same"(${w.ref.id}::text, ${w.ref.accountId}::text, ${drift0}::text)`;
          return null;
        })
        .then(
          () => 'passed',
          (e: Error) => e.message,
        );
      expect(changed).toMatch(/PUB_BUDGET_COUNTERS_MISMATCH/);

      // Починка: оператору нельзя, основание обязательно, владелец — пересборка.
      const byOp = await op.post(`${P}/budget/rebuild-counters`, {
        basis: 'Розбіжність після ручної правки бази',
      });
      expect(byOp.status).toBe(403);
      const short = await po.post(`${P}/budget/rebuild-counters`, {
        basis: 'коротко',
      });
      expect(short.status).toBe(400);
      const fix = await po.post(`${P}/budget/rebuild-counters`, {
        basis: 'Розбіжність після ручної правки бази',
      });
      expect(fix.status).toBe(200);
      expect(
        await s.prisma.$transaction((tx) =>
          budgetFn.drift(tx as unknown as PubTx, w.ref),
        ),
      ).toBe('');
      const exp = await s.prisma.$transaction((tx) =>
        budgetFn.expected(tx as unknown as PubTx, w.product.id),
      );
      expect(await limitCounters(s.prisma, w.product.id)).toMatchObject({
        netPaidMinor: exp.netPaid,
        openCommitMinor: exp.openCommit,
        usedPlacementsMinor: exp.usedPlacements,
        usedToolsMinor: exp.usedTools,
      });
      expect(
        await s.prisma.pubExpense.findFirstOrThrow({ where: { id: tools.id } }),
      ).toMatchObject({ paidMinor: 10_000n, cancelledMinor: 5_000n });
      const audit = await s.prisma.pubAuditEvent.findFirstOrThrow({
        where: {
          productId: w.product.id,
          objectType: 'budget_limit',
          action: 'update',
          actor: `member:${w.team.product_owner.memberId}`,
        },
      });
      expect(audit.reason).toBe('Розбіжність після ручної правки бази');
      expect(audit.meta).toMatchObject({
        rebuild: true,
        heads: 1,
        netPaidDelta: 10000,
        openCommitDelta: -10000,
      });
      // Новые обязательства снова возможны.
      const after = await op.post(`${P}/expenses`, {
        category: 'other',
        description: 'Нова витрата',
        amount: { currency: 'UAH', minor: '100' },
      });
      expect(after.status).toBe(201);
    });
  },
);
