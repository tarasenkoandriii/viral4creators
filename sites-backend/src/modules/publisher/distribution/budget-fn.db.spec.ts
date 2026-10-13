/**
 * AI Publisher, P-C — db-тесты функций денег `sites.pub_budget_*`
 * (миграция `20261016092000_publisher_budget_fn`; проектный документ §6.9,
 * §8.2): сверка счётчиков внутри функций ловит запись мимо функций,
 * условия резерва и категорий, отмена/возврат/оказано/корректировка,
 * перевод резерва, сборка лимита из параметров с сохранением переводов,
 * остановка новых обязательств открытой задачей ежедневной сверки,
 * статическая форма миграции слота.
 *
 * Каждый тест — своя транзакция с откатом (харнесс P-A0); ожидаемый отказ
 * — под SAVEPOINT. Строка — `SITES_DIRECT_URL`.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Client } from 'pg';
import {
  PUB_RAW_URL,
  PubDb,
  connectOwner,
  describeWithoutDb,
  uuid4,
  type PubWorld,
} from '../../../prisma/publisher-schema.testing';

const MIG = path.join(
  __dirname,
  '../../../../prisma/migrations/20261016092000_publisher_budget_fn/migration.sql',
);

describe('миграция publisher_budget_fn — контракт слота (статика)', () => {
  const sql = fs.readFileSync(MIG, 'utf8').replace(/--[^\n]*/g, ''); // комментарии упоминают запреты словами
  it('только функции: без CREATE/ALTER TABLE, CHECK и CONSTRAINT TRIGGER', () => {
    expect(sql).not.toMatch(
      /CREATE\s+TABLE|ALTER\s+TABLE|CONSTRAINT\s+TRIGGER|\bCHECK\s*\(/i,
    );
  });
  it('функции, читающие таблицы, — SECURITY DEFINER + search_path; EXECUTE у PUBLIC снят', () => {
    const fns = [
      ...sql.matchAll(
        /CREATE FUNCTION "(\w+)"\(([\s\S]*?)\bAS \$\$([\s\S]*?)\$\$/g,
      ),
    ];
    expect(fns.length).toBeGreaterThanOrEqual(17);
    const bad = fns
      .filter(([, , , body]) =>
        /"sites"\."(pub|site)_[a-z_]+"(?!\s*\()/.test(body),
      )
      .filter(
        ([, , head]) =>
          !/SECURITY DEFINER SET search_path = pg_catalog, pg_temp/.test(head),
      )
      .map(([, name]) => name);
    expect(bad).toEqual([]);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION %s FROM PUBLIC/);
  });
});

if (!PUB_RAW_URL) {
  describeWithoutDb('функции денег pub_budget_* (db)');
} else {
  describe('функции денег pub_budget_* (db)', () => {
    let c: Client;
    let db: PubDb;
    let w: PubWorld;
    const A = 'member:op1';

    beforeAll(async () => {
      c = await connectOwner();
      db = new PubDb(c);
    });
    afterAll(async () => {
      await c.end();
    });
    beforeEach(async () => {
      await db.begin();
      w = await db.world({ kind: 'test' });
      await apply(10_000, 6_000, 2_000, 2_000, 2_000, 3);
    });
    afterEach(async () => {
      await db.rollback();
    });

    const K = (uah: number) => String(uah * 100);
    const one = async <T = string>(
      sql: string,
      params: unknown[],
    ): Promise<T> => (await db.q<{ r: T }>(`SELECT ${sql} AS r`, params))[0].r;
    const apply = (
      t: number,
      pl: number,
      tl: number,
      rs: number,
      per: number,
      ver: number,
    ) =>
      one(
        `"sites"."pub_budget_apply_limits"($1,$2,'UAH',$3::bigint,$4::bigint,$5::bigint,$6::bigint,$7::bigint,$8::int,$9)`,
        [
          w.productId,
          w.accountId,
          K(t),
          K(pl),
          K(tl),
          K(rs),
          K(per),
          ver,
          'system:test',
        ],
      );
    const tools = (uah: number, cat = 'tools') =>
      one(
        `"sites"."pub_budget_commit_tools"($1,$2,$3::bigint,$4,'Інструмент',NULL,NULL,NULL,NULL,NULL,NULL,$5,$6)`,
        [w.productId, w.accountId, K(uah), cat, uuid4(), A],
      );
    const pay = (
      e: string,
      uah: number,
      status = 'confirmed',
      ref: string | null = null,
    ) =>
      one(
        `"sites"."pub_budget_pay"($1,$2,$3,$4::bigint,$5,$6,NULL,NULL,now(),$7,$8)`,
        [w.productId, w.accountId, e, K(uah), status, ref, uuid4(), A],
      );
    const limitRow = async () =>
      (
        await db.q<Record<string, string>>(
          `SELECT "netPaidMinor"::text AS np, "openCommitMinor"::text AS oc, "usedPlacementsMinor"::text AS up,
                  "usedToolsMinor"::text AS ut, "protectedReserveMinor"::text AS pr, "placementsLimitMinor"::text AS pl,
                  "toolsLimitMinor"::text AS tl, "totalLimitMinor"::text AS tot, "paramVersion" AS pv
             FROM "sites"."pub_budget_limits" WHERE "productId" = $1`,
          [w.productId],
        )
      )[0];
    const fails = (code: string, fn: () => Promise<unknown>) =>
      db.fails('P0001', fn, new RegExp(`^${code}$`));

    it('commit_tools: остаток и лимит категории (other — в tools); стоп при 100 %', async () => {
      const e = await tools(1_500);
      expect(e).toMatch(/^exp_/);
      await fails('PUB_BUDGET_INSUFFICIENT', () => tools(501, 'other'));
      await tools(500, 'other');
      expect(await limitRow()).toMatchObject({ oc: K(2_000), ut: K(2_000) });
    });

    it('pay: confirmed переносит open → net_paid; unknown удерживает и блокирует повтор; сверх обязательства — отказ', async () => {
      const e = await tools(1_000);
      await fails('PUB_AMOUNT_EXCEEDS_OPEN', () => pay(e, 1_001));
      await pay(e, 400);
      expect(await limitRow()).toMatchObject({
        np: K(400),
        oc: K(600),
        ut: K(1_000),
      });
      const unk = await pay(e, 600, 'unknown', 'PSP-1');
      expect(await limitRow()).toMatchObject({ np: K(400), oc: K(600) });
      const head = (
        await db.q<{ rr: boolean; st: string }>(
          `SELECT "reconcileRequired" AS rr, status AS st FROM "sites"."pub_expenses" WHERE id = $1`,
          [e],
        )
      )[0];
      expect(head).toEqual({ rr: true, st: 'open' });
      await fails('PUB_RECONCILE_REQUIRED', () => pay(e, 1));
      await fails('PUB_RECONCILE_REQUIRED', () =>
        one(
          `"sites"."pub_budget_cancel"($1,$2,$3,$4::bigint,NULL,NULL,now(),$5,$6)`,
          [w.productId, w.accountId, e, K(1), uuid4(), A],
        ),
      );
      await one(`"sites"."pub_budget_reconcile"($1,$2,$3,'confirmed',$4)`, [
        w.productId,
        w.accountId,
        unk,
        A,
      ]);
      expect(await limitRow()).toMatchObject({ np: K(1_000), oc: '0' });
      const closed = (
        await db.q<{ st: string; rr: boolean }>(
          `SELECT status AS st, "reconcileRequired" AS rr FROM "sites"."pub_expenses" WHERE id = $1`,
          [e],
        )
      )[0];
      expect(closed).toEqual({ st: 'closed', rr: false });
      await fails('PUB_TRANSITION_INVALID', () =>
        one(`"sites"."pub_budget_reconcile"($1,$2,$3,'void',$4)`, [
          w.productId,
          w.accountId,
          unk,
          A,
        ]),
      );
    });

    it('cancel/refund/deliver: освобождается только подтверждённое; delivered_unpaid не трогает остаток', async () => {
      const e = await tools(1_000);
      await one(
        `"sites"."pub_budget_deliver"($1,$2,$3,$4::bigint,NULL,NULL,now(),$5,$6)`,
        [w.productId, w.accountId, e, K(400), uuid4(), A],
      );
      expect(await limitRow()).toMatchObject({ oc: K(1_000), ut: K(1_000) });
      await fails('PUB_AMOUNT_EXCEEDS_OPEN', () =>
        one(
          `"sites"."pub_budget_deliver"($1,$2,$3,$4::bigint,NULL,NULL,now(),$5,$6)`,
          [w.productId, w.accountId, e, K(601), uuid4(), A],
        ),
      );
      await pay(e, 500);
      await one(
        `"sites"."pub_budget_cancel"($1,$2,$3,$4::bigint,'Лист',NULL,now(),$5,$6)`,
        [w.productId, w.accountId, e, K(300), uuid4(), A],
      );
      expect(await limitRow()).toMatchObject({
        np: K(500),
        oc: K(200),
        ut: K(700),
      });
      // Обещанный возврат: запись есть, деньги не двигаются.
      const promised = await one(
        `"sites"."pub_budget_refund"($1,$2,$3,$4::bigint,'pending',NULL,NULL,'Обіцяли',now(),$5,$6)`,
        [w.productId, w.accountId, e, K(500), uuid4(), A],
      );
      expect(await limitRow()).toMatchObject({ np: K(500) });
      await one(`"sites"."pub_budget_reconcile"($1,$2,$3,'confirmed',$4)`, [
        w.productId,
        w.accountId,
        promised,
        A,
      ]);
      expect(await limitRow()).toMatchObject({
        np: '0',
        oc: K(200),
        ut: K(200),
      });
      await fails('PUB_AMOUNT_EXCEEDS_OPEN', () =>
        one(
          `"sites"."pub_budget_refund"($1,$2,$3,$4::bigint,'confirmed',NULL,NULL,NULL,now(),$5,$6)`,
          [w.productId, w.accountId, e, K(1), uuid4(), A],
        ),
      );
    });

    it('adjust: отрицательная не ниже оплаченного; положительная tools — по условию остатка; закупка без согласования — PUB_APPROVAL_REQUIRED', async () => {
      const e = await tools(1_000);
      await pay(e, 600);
      await fails('PUB_AMOUNT_EXCEEDS_OPEN', () =>
        one(
          `"sites"."pub_budget_adjust"($1,$2,$3,$4::bigint,'Менше',NULL,NULL,NULL,now(),$5,$6)`,
          [w.productId, w.accountId, e, '-50000', uuid4(), A],
        ),
      );
      await one(
        `"sites"."pub_budget_adjust"($1,$2,$3,$4::bigint,'Менше',NULL,NULL,NULL,now(),$5,$6)`,
        [w.productId, w.accountId, e, '-40000', uuid4(), A],
      );
      expect(await limitRow()).toMatchObject({
        np: K(600),
        oc: '0',
        ut: K(600),
      });
      await one(
        `"sites"."pub_budget_adjust"($1,$2,$3,$4::bigint,'Більше',NULL,NULL,NULL,now(),$5,$6)`,
        [w.productId, w.accountId, e, K(1_400), uuid4(), A],
      );
      expect(await limitRow()).toMatchObject({ oc: K(1_400), ut: K(2_000) });
      await fails('PUB_BUDGET_INSUFFICIENT', () =>
        one(
          `"sites"."pub_budget_adjust"($1,$2,$3,$4::bigint,'Ще',NULL,NULL,NULL,now(),$5,$6)`,
          [w.productId, w.accountId, e, K(1), uuid4(), A],
        ),
      );
      // Закупка: обязательство по согласованию; положительная — только с новым.
      const { placementId, approvalId } = await db.approvedPlacement(w, {
        maxAmountMinor: 100_000,
        priceSnapshotHash: 'a'.repeat(64),
      });
      const pe = await one(
        `"sites"."pub_budget_reserve"($1,$2,100000::bigint,'placements',$3,$4,$5,
           (SELECT revision FROM "sites"."pub_placements" WHERE id = $5),$6,$7)`,
        [
          w.productId,
          w.accountId,
          approvalId,
          'a'.repeat(64),
          placementId,
          uuid4(),
          A,
        ],
      ).catch((err: Error) => err);
      // Закупка-кандидат харнесса в статусе proposed — резерв её не берёт.
      expect(String(pe)).toMatch(/PUB_CONFLICT/);
    });

    it('reserve: предел одной закупки, лимит размещений, остаток; согласование истёкшее/чужое/устаревшее', async () => {
      const mk = async (total: number) => {
        const t = total * 100;
        const placementId = await db.placement(w, {
          basePriceMinor: t,
          feesMinor: 0,
          totalPriceMinor: t,
        });
        const approvalId = await db.purchaseApproval(w, {
          objectId: placementId,
          maxAmountMinor: t,
          priceSnapshotHash: 'b'.repeat(64),
        });
        await db.upd('pub_placements', placementId, {
          approvalId,
          status: 'approved',
          priceConfirmedAt: new Date(),
          priceSource: 'Прайс',
        });
        const rev = (
          await db.q<{ r: number }>(
            `SELECT revision AS r FROM "sites"."pub_placements" WHERE id = $1`,
            [placementId],
          )
        )[0].r;
        return { placementId, approvalId, rev };
      };
      const reserve = (
        x: { placementId: string; approvalId: string; rev: number },
        total: number,
        snap = 'b'.repeat(64),
      ) =>
        one(
          `"sites"."pub_budget_reserve"($1,$2,$3::bigint,'placements',$4,$5,$6,$7::int,$8,$9)`,
          [
            w.productId,
            w.accountId,
            K(total),
            x.approvalId,
            snap,
            x.placementId,
            x.rev,
            uuid4(),
            A,
          ],
        );
      const big = await mk(2_001);
      await fails('PUB_BUDGET_INSUFFICIENT', () => reserve(big, 2_001));
      const p1 = await mk(2_000);
      await fails('PUB_APPROVAL_STALE', () =>
        reserve(p1, 2_000, 'c'.repeat(64)),
      );
      await fails('PUB_CONFLICT', () =>
        reserve({ ...p1, rev: p1.rev + 5 }, 2_000),
      );
      const e1 = await reserve(p1, 2_000);
      expect(e1).toMatch(/^exp_/);
      const st = (
        await db.q<{ s: string; ap: string }>(
          `SELECT p.status AS s, a.status AS ap FROM "sites"."pub_placements" p JOIN "sites"."pub_approvals" a ON a.id = p."approvalId" WHERE p.id = $1`,
          [p1.placementId],
        )
      )[0];
      expect(st).toEqual({ s: 'budget_reserved', ap: 'consumed' });
      // Повтор того же резерва: согласование уже израсходовано.
      await fails('PUB_APPROVAL_REQUIRED', () =>
        reserve({ ...p1, rev: p1.rev + 1 }, 2_000),
      );
      await reserve(await mk(2_000), 2_000);
      await reserve(await mk(2_000), 2_000);
      // Лимит размещений 6 000 исчерпан.
      const p4 = await mk(1);
      await fails('PUB_BUDGET_INSUFFICIENT', () => reserve(p4, 1));
      expect(await limitRow()).toMatchObject({ oc: K(6_000), up: K(6_000) });
    });

    it('release: перевод резерва — лимит категории растёт, общий нет; только по действующему согласованию', async () => {
      const appr = await db.reserveApproval(w, { maxAmountMinor: 50_000 });
      await one(
        `"sites"."pub_budget_release"($1,$2,'placements',$3::bigint,$4,$5)`,
        [w.productId, w.accountId, K(300), appr, A],
      );
      expect(await limitRow()).toMatchObject({
        tot: K(10_000),
        pr: K(1_700),
        pl: K(6_300),
      });
      await db.rejects(() =>
        one(`"sites"."pub_budget_release"($1,$2,'tools',$3::bigint,$4,$5)`, [
          w.productId,
          w.accountId,
          K(201),
          appr,
          A,
        ]),
      );
      await fails('PUB_BUDGET_INSUFFICIENT', () =>
        one(`"sites"."pub_budget_release"($1,$2,'tools',$3::bigint,$4,$5)`, [
          w.productId,
          w.accountId,
          K(1_701),
          appr,
          A,
        ]),
      );
      // Повторная сборка из параметров сохраняет перевод (§6.4).
      await apply(10_000, 6_000, 2_000, 2_000, 2_000, 6);
      expect(await limitRow()).toMatchObject({
        pr: K(1_700),
        pl: K(6_300),
        pv: 6,
      });
      // Новый резерв меньше уже переведённого — лимит не собирается (NULL), строка прежняя.
      expect(await apply(10_000, 7_800, 2_000, 200, 2_000, 9)).toBeNull();
      expect(await limitRow()).toMatchObject({ pv: 6 });
    });

    it('резерв и расход проверяют ОБЩИЙ остаток, даже если лимит категории шире (строка лимита правлена мимо параметров)', async () => {
      // Несогласованная строка (категории + резерв > общего) — условие
      // общего остатка остаётся отдельной линией защиты.
      await db.q(
        `UPDATE "sites"."pub_budget_limits" SET "toolsLimitMinor" = $2 WHERE "productId" = $1`,
        [w.productId, K(9_000)],
      );
      await tools(7_000);
      await fails('PUB_BUDGET_INSUFFICIENT', () => tools(1_001));
      await tools(1_000);
      expect(await limitRow()).toMatchObject({ oc: K(8_000), ut: K(8_000) });
      // Резерв закупки: лимит размещений и предел закупки шире, общий
      // остаток — 0 → отказ условием общего остатка.
      await db.q(
        `UPDATE "sites"."pub_budget_limits" SET "placementsLimitMinor" = $2, "perPurchaseMaxMinor" = $2
          WHERE "productId" = $1`,
        [w.productId, K(9_000)],
      );
      const placementId = await db.placement(w, {
        basePriceMinor: 10_000,
        feesMinor: 0,
        totalPriceMinor: 10_000,
      });
      const approvalId = await db.purchaseApproval(w, {
        objectId: placementId,
        maxAmountMinor: 10_000,
        priceSnapshotHash: 'd'.repeat(64),
      });
      await db.upd('pub_placements', placementId, {
        approvalId,
        status: 'approved',
        priceConfirmedAt: new Date(),
        priceSource: 'Прайс',
      });
      await fails('PUB_BUDGET_INSUFFICIENT', () =>
        one(
          `"sites"."pub_budget_reserve"($1,$2,10000::bigint,'placements',$3,$4,$5,
             (SELECT revision FROM "sites"."pub_placements" WHERE id = $5),$6,$7)`,
          [
            w.productId,
            w.accountId,
            approvalId,
            'd'.repeat(64),
            placementId,
            uuid4(),
            A,
          ],
        ),
      );
    });

    it('apply_limits: смена валюты при записанных обязательствах — не собирает', async () => {
      await tools(100);
      expect(
        await one(
          `"sites"."pub_budget_apply_limits"($1,$2,'USD',1::bigint,0::bigint,1::bigint,0::bigint,0::bigint,9,'system:t')`,
          [w.productId, w.accountId],
        ),
      ).toBeNull();
    });

    it('сверка внутри функций: запись мимо функции и правка счётчика — PUB_BUDGET_COUNTERS_MISMATCH', async () => {
      const e = await tools(1_000);
      // Обходная запись оплаты прямо в журнал.
      await db.child('pub_expense_entries', w, {
        expenseId: e,
        kind: 'pay',
        amountMinor: 10_000,
        status: 'confirmed',
        occurredAt: new Date(),
        confirmedAt: new Date(),
        confirmedBy: A,
        opKey: uuid4(),
      });
      await fails('PUB_BUDGET_COUNTERS_MISMATCH', () => tools(10));
      const exp = (
        await db.q<{ hb: number }>(
          `SELECT "headsBad" AS hb FROM "sites"."pub_budget_expected"($1)`,
          [w.productId],
        )
      )[0];
      expect(exp.hb).toBe(1);
    });

    it('сверка внутри функций: правка счётчика строки лимита мимо функции ловится следующей операцией', async () => {
      await tools(100);
      await db.q(
        `UPDATE "sites"."pub_budget_limits" SET "netPaidMinor" = 1 WHERE "productId" = $1`,
        [w.productId],
      );
      await fails('PUB_BUDGET_COUNTERS_MISMATCH', () => tools(10));
    });

    it('открытая задача ежедневной сверки останавливает новые обязательства (STOPPED), но не оплату', async () => {
      const e = await tools(100);
      await db.child('pub_review_tasks', w, {
        objectType: 'budget_limit',
        objectId: 'bl',
        reason: 'other',
        triggerRef: 'budget-reconcile:2026-10-13',
        severity: 'critical',
        createdBy: 'system:budget-reconcile',
      });
      await fails('PUB_BUDGET_STOPPED', () => tools(10));
      await pay(e, 100);
      expect(await limitRow()).toMatchObject({ np: K(100) });
    });
  });
}
