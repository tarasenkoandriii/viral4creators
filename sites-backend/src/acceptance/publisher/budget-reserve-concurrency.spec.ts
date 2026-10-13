/**
 * [AT-CORE-14] Два претендента на остаток бюджета (P-C, проектный документ
 * §8.2): резерв атомарен — условный UPDATE строки лимита в
 * `sites.pub_budget_reserve` перепроверяет остаток на последней версии
 * строки после ожидания блокировки; из одного остатка нельзя принять обе.
 *
 *  1. Настоящая гонка двух соединений (pg, явные транзакции): первое
 *     держит блокировку строки лимита, второе ждёт (видно в
 *     pg_stat_activity), после COMMIT первого второе получает
 *     PUB_BUDGET_INSUFFICIENT — ни одна проверка «прочитал → решил» в
 *     сервисе здесь не участвует.
 *  2. Два параллельных HTTP-резерва по 3 000 на остаток 5 000 (вектор §17)
 *     → один 200, второй 409 PUB_BUDGET_INSUFFICIENT.
 *  3. 20 параллельных претендентов → ровно один успех, остальные
 *     ∈ {INSUFFICIENT, BUSY}; счётчики сходятся с записями (сверка).
 */
import { randomBytes } from 'crypto';
import { Client } from 'pg';
import { ciDescribe } from '../../prisma/ci-describe.testing';
import { pgUrl } from '../../prisma/publisher-schema.testing';
import { BudgetReconcileJob } from '../../modules/publisher/distribution/budget-reconcile.job';
import {
  apiAs,
  approvedPlacementDirect,
  distStack,
  limitCounters,
  opKey,
  rawPost,
  seedTd08,
  seedTz17State,
  type DistStack,
} from '../../modules/publisher/distribution/testing/td08.testing';

jest.setTimeout(180_000);

const BUDGET = {
  total: 10_000,
  placements: 6_000,
  tools: 2_000,
  reserve: 2_000,
  perPurchase: 3_000,
};

async function connect(): Promise<Client> {
  const c = new Client({
    connectionString: pgUrl(process.env.SITES_DIRECT_URL as string),
  });
  await c.connect();
  await c.query(`SET search_path = sites`);
  return c;
}

ciDescribe('[AT-CORE-14] два претендента на остаток — резерв атомарный', () => {
  let s: DistStack;
  beforeAll(async () => {
    s = await distStack();
  });
  afterAll(async () => {
    await s.close();
  });

  it('гонка двух соединений: второй ждёт блокировку строки лимита и после COMMIT первого получает PUB_BUDGET_INSUFFICIENT', async () => {
    const w = await seedTd08(s.prisma, s.budget, { budget: BUDGET });
    await seedTz17State(s.prisma, w);
    expect((await s.budget.snapshot(s.prisma as never, w.ref)).available).toBe(
      500_000n,
    );
    const a = await approvedPlacementDirect(s.prisma, w, {
      seq: 1,
      totalUah: 3_000,
      campaignCode: `ra-${randomBytes(3).toString('hex')}`,
    });
    const b = await approvedPlacementDirect(s.prisma, w, {
      seq: 1,
      totalUah: 3_000,
      campaignCode: `rb-${randomBytes(3).toString('hex')}`,
    });
    const actor = `member:${w.team.operator.memberId}`;
    const call = (c: Client, x: typeof a) =>
      c.query(
        `SELECT "sites"."pub_budget_reserve"($1, $2, $3::bigint, 'placements', $4, $5, $6, $7::int, $8, $9) AS r`,
        [
          w.ref.id,
          w.ref.accountId,
          '300000',
          x.approvalId,
          x.snapshot,
          x.placementId,
          x.revision,
          opKey(),
          actor,
        ],
      );
    const c1 = await connect();
    const c2 = await connect();
    try {
      await c1.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await c2.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      const pid2 = (await c2.query('SELECT pg_backend_pid() AS p')).rows[0]
        .p as number;
      const r1 = await call(c1, a);
      expect(r1.rows[0].r).toMatch(/^exp_/);
      // Второй претендент: запрос уходит и ждёт блокировку строки лимита.
      let second: { ok: boolean; code?: string; message?: string } | null =
        null;
      const p2 = call(c2, b).then(
        () => (second = { ok: true }),
        (e: { code?: string; message?: string }) =>
          (second = { ok: false, code: e.code, message: e.message }),
      );
      let waiting = false;
      for (let i = 0; i < 50 && !waiting; i++) {
        await new Promise((r) => setTimeout(r, 50));
        const st = await s.prisma.$queryRawUnsafe<Array<{ w: string | null }>>(
          `SELECT wait_event_type AS w FROM pg_stat_activity WHERE pid = ${pid2}`,
        );
        waiting = st[0]?.w === 'Lock';
      }
      expect(waiting).toBe(true);
      expect(second).toBeNull();
      await c1.query('COMMIT');
      await p2;
      expect(second).toEqual(
        expect.objectContaining({
          ok: false,
          code: 'P0001',
          message: 'PUB_BUDGET_INSUFFICIENT',
        }),
      );
      await c2.query('ROLLBACK');
    } finally {
      await c1.end();
      await c2.end();
    }
    const after = await s.budget.snapshot(s.prisma as never, w.ref);
    expect(after.available).toBe(200_000n);
    expect(after.openCommitment).toBe(400_000n);
    expect(
      await s.prisma.pubApproval.findFirst({
        where: { id: b.approvalId },
        select: { status: true },
      }),
    ).toEqual({ status: 'active' });
    expect(
      (await s.prisma.pubPlacement.findFirst({ where: { id: b.placementId } }))
        ?.status,
    ).toBe('approved');
  });

  it('два параллельных HTTP-резерва по 3 000 на остаток 5 000: один 200, второй 409 PUB_BUDGET_INSUFFICIENT', async () => {
    const w = await seedTd08(s.prisma, s.budget, { budget: BUDGET });
    await seedTz17State(s.prisma, w);
    const xs = await Promise.all(
      [0, 1].map((i) =>
        approvedPlacementDirect(s.prisma, w, {
          seq: 1,
          totalUah: 3_000,
          campaignCode: `h${i}-${randomBytes(3).toString('hex')}`,
        }),
      ),
    );
    const op = apiAs(s.app!.getHttpServer(), w.acc.accountId, w.team.operator);
    const P = `/publisher/products/${w.product.id}`;
    const rs = await Promise.all(
      xs.map((x) =>
        op.post(`${P}/placements/${x.placementId}/reserve`, {
          expectedRevision: x.revision,
        }),
      ),
    );
    const codes = rs
      .map((r) => (r.status === 200 ? 'OK' : r.body.error?.code))
      .sort();
    expect(codes).toEqual(['OK', 'PUB_BUDGET_INSUFFICIENT']);
    const loser = rs.find((r) => r.status !== 200)!;
    expect(loser.status).toBe(409);
    expect(loser.body.error.details).toMatchObject({ requested: '300000' });
    expect((await op.get(`${P}/budget`)).body.data).toMatchObject({
      available: '200000',
      openCommitment: '400000',
    });
  });

  it('20 параллельных претендентов: ровно один успех, остальные INSUFFICIENT/BUSY; счётчики = записи', async () => {
    const w = await seedTd08(s.prisma, s.budget, { budget: BUDGET });
    await seedTz17State(s.prisma, w);
    const xs = [];
    for (let i = 0; i < 20; i++) {
      xs.push(
        await approvedPlacementDirect(s.prisma, w, {
          seq: 1,
          totalUah: 3_000,
          campaignCode: `z${i}-${randomBytes(3).toString('hex')}`,
        }),
      );
    }
    const srv = s.app!.getHttpServer();
    if (!srv.address())
      await new Promise<void>((r) => srv.listen(0, () => r()));
    const port = (srv.address() as { port: number }).port;
    const h = apiAs(srv, w.acc.accountId, w.team.operator).headers;
    const P = `/publisher/products/${w.product.id}`;
    const rs = await Promise.all(
      xs.map((x) =>
        rawPost(port, `${P}/placements/${x.placementId}/reserve`, h, {
          opKey: opKey(),
          expectedRevision: x.revision,
        }),
      ),
    );
    const ok = rs.filter((r) => r.status === 200);
    const other = rs
      .filter((r) => r.status !== 200)
      .map((r) => r.body.error?.code);
    expect(ok).toHaveLength(1);
    expect(other).toHaveLength(19);
    for (const c of other)
      expect(['PUB_BUDGET_INSUFFICIENT', 'PUB_BUSY']).toContain(c);
    expect(await limitCounters(s.prisma, w.product.id)).toMatchObject({
      netPaidMinor: 200_000n,
      openCommitMinor: 400_000n,
      usedPlacementsMinor: 400_000n,
    });
    const job = s.mod.get(BudgetReconcileJob);
    const r = await s.prisma.$transaction((tx) =>
      job.reconcileOne(tx as never, w.ref, new Date()),
    );
    expect(r).toEqual({ productId: w.product.id, ok: true, diff: {} });
    expect(
      await s.prisma.pubExpense.count({
        where: { productId: w.product.id, category: 'placements' },
      }),
    ).toBe(2);
  });
});
