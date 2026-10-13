/**
 * AI Publisher — приёмка P-E: порог не переписан задним числом (AT-CORE-23,
 * db-часть; юнит — `reports-signal.spec`). Пороги замораживаются в версии
 * эксперимента при регистрации, триггер `pub_experiments_guard` запрещает
 * их правку; новая гипотеза — новая версия; t0 ставится один раз; снимок D42
 * берёт пороги версии, действовавшей на t0.
 */
import { ciDescribe } from '../../prisma/ci-describe.testing';
import {
  PubDb,
  connectOwner,
  type PubWorld,
} from '../../prisma/publisher-schema.testing';
import { ExperimentsService } from '../../modules/publisher/reports/experiments.service';
import { ReportsService } from '../../modules/publisher/reports/reports.service';
import {
  T0,
  T42,
  T72,
  T90,
  d,
  seedLead,
  seedPilotWorld,
  seedSession,
} from '../../modules/publisher/reports/testing/pilot-world.testing';
import {
  reportsStack,
  type ReportsStack,
} from '../../modules/publisher/reports/testing/reports-stack.testing';

ciDescribe(
  '[AT-CORE-23] Порог не переписан задним числом: заморозка, новая версия, t0 один раз',
  () => {
    let s: ReportsStack;
    let owner: Awaited<ReturnType<typeof connectOwner>>;
    let raw: PubDb;
    let w: PubWorld;
    let exps: ExperimentsService;
    let reports: ReportsService;
    const actors = ['analyst'] as const;

    beforeAll(async () => {
      s = await reportsStack();
      owner = await connectOwner();
      raw = new PubDb(owner);
      exps = s.mod.get(ExperimentsService);
      reports = s.mod.get(ReportsService);
      w = await raw.world({ kind: 'working' });
      // Пороги-параметры: d42 утверждён v1 (100/5/2, выборка 5).
      await raw.decidedParam(
        w,
        'd42_thresholds',
        {
          sessions: 100,
          qualified: 5,
          proposals: 2,
          minSampleForConclusion: 5,
        },
        'approved',
      );
    });
    afterAll(async () => {
      await owner?.end();
      await s?.close();
    });
    const tx = <T>(
      fn: (
        t: Parameters<
          Parameters<
            ReturnType<ReportsStack['db']['forAccount']>['$transaction']
          >[0]
        >[0],
      ) => Promise<T>,
    ) => s.db.forAccount(w.accountId).$transaction(fn) as Promise<T>;
    const product = () => ({
      id: w.productId,
      accountId: w.accountId,
      siteId: w.siteId,
      kind: 'working' as const,
      mode: 'closed' as const,
      status: 'active' as const,
      revision: 1,
    });

    /** Решение по параметру: снизить порог заявок до 1 (v2, утверждено). */
    async function lowerThreshold(): Promise<void> {
      await raw.child('pub_parameter_decisions', w, {
        parameterKey: 'd42_thresholds',
        version: 2,
        fromStatus: 'approved',
        toStatus: 'approved',
        valueSnapshot: {
          sessions: 100,
          qualified: 1,
          proposals: 2,
          minSampleForConclusion: 1,
        },
        decidedBy: 'member:m1',
        basis: 'Знизити поріг після старту (перевірка заборони)',
        dependentStages: ['reports'],
      });
      const p = await s.prisma.pubParameter.findFirstOrThrow({
        where: { productId: w.productId, key: 'd42_thresholds' },
      });
      await raw.upd('pub_parameters', p.id, {
        value: {
          sessions: 100,
          qualified: 1,
          proposals: 2,
          minSampleForConclusion: 1,
        },
        version: 2,
        approvedAt: new Date(),
      });
    }

    it('регистрация замораживает пороги с версией параметра; правка порогов/гипотезы и удаление — 23514', async () => {
      const start = new Date(Date.now() + 86_400_000);
      const r = await tx((t) =>
        exps.register(
          t,
          product(),
          {
            key: 'cta-change',
            hypothesis: 'Новий CTA збільшить кваліфіковані звернення',
            change: 'CTA на сторінці матеріалу',
            metric: 'Кваліфіковані prospect_id',
            expectedSignal: '≥ 2 кваліфікованих за вікно',
            stopConditions: 'Витрачено ліміт',
            windowStart: start.toISOString(),
            windowEnd: new Date(
              start.getTime() + 14 * 86_400_000,
            ).toISOString(),
            limitMinor: '50000',
          },
          'member:m1',
          new Date(),
        ),
      );
      const th = r.row.thresholds as {
        d42: Record<string, number>;
        versions: Record<string, { version: number; status: string }>;
      };
      expect(th.d42).toEqual({
        sessions: 100,
        qualified: 5,
        proposals: 2,
        minSampleForConclusion: 5,
      });
      expect(th.versions.d42_thresholds).toEqual({
        version: 1,
        status: 'approved',
      });
      await lowerThreshold();
      const again = await s.prisma.pubExperiment.findUniqueOrThrow({
        where: { id: r.row.id },
      });
      expect(
        (again.thresholds as { d42: { qualified: number } }).d42.qualified,
      ).toBe(5);
      for (const sql of [
        `UPDATE "sites"."pub_experiments" SET "thresholds" = '{"d42":{"qualified":1}}' WHERE "id" = $1`,
        `UPDATE "sites"."pub_experiments" SET "hypothesis" = 'Інша гіпотеза' WHERE "id" = $1`,
        `UPDATE "sites"."pub_experiments" SET "windowEnd" = "windowEnd" + interval '1 day' WHERE "id" = $1`,
        `DELETE FROM "sites"."pub_experiments" WHERE "id" = $1`,
      ]) {
        await expect(raw.q(sql, [r.row.id])).rejects.toMatchObject({
          code: '23514',
        });
      }
      // Новая гипотеза — НОВАЯ версия с текущими порогами; прежняя — superseded и неизменна.
      const v2 = await tx((t) =>
        exps.newVersion(
          t,
          product(),
          r.row.id,
          { hypothesis: 'Уточнена гіпотеза: CTA з поясненням' },
          [...actors],
          'member:m1',
          new Date(),
        ),
      );
      expect(v2.row).toMatchObject({
        key: 'cta-change',
        version: 2,
        supersedesId: r.row.id,
        status: 'registered',
      });
      expect(
        (v2.row.thresholds as { d42: { qualified: number } }).d42.qualified,
      ).toBe(1);
      const v1 = await s.prisma.pubExperiment.findUniqueOrThrow({
        where: { id: r.row.id },
      });
      expect(v1.status).toBe('superseded');
      expect(v1.hypothesis).toBe('Новий CTA збільшить кваліфіковані звернення');
    });

    it('t0 ставится один раз: второй вызов setT0Once — null; прямой UPDATE вех — 23514', async () => {
      const w2 = await raw.world({ kind: 'working' });
      await raw.experiment(w2, {
        key: 'pilot',
        kind: 'pilot',
        registeredAt: d('2026-01-01T08:00:00Z'),
        windowStart: T0,
        windowEnd: T90,
      });
      const p2 = { id: w2.productId, accountId: w2.accountId };
      const first = await s.db
        .forAccount(w2.accountId)
        .$transaction((t) => exps.setT0Once(t, p2, T0));
      // Вехи от t0 — ручной пересчёт (см. pilot-world.testing.ts).
      expect(first).toEqual({ t0: T0, t42: T42, t72: T72, t90: T90 });
      const second = await s.db
        .forAccount(w2.accountId)
        .$transaction((t) => exps.setT0Once(t, p2, d('2026-02-01T08:00:00Z')));
      expect(second).toBeNull();
      const row = await s.prisma.pubExperiment.findFirstOrThrow({
        where: { productId: w2.productId },
      });
      expect(row).toMatchObject({ t0: T0, t42: T42, status: 'running' });
      await expect(
        raw.q(
          `UPDATE "sites"."pub_experiments" SET "t0" = now(), "t42" = now() + interval '42 day', "t72" = now() + interval '72 day', "t90" = now() + interval '90 day' WHERE "id" = $1`,
          [row.id],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('после t0 гипотеза и пороги пилота не меняются: новая версия — только конец поздней когорты, пороги копируются; D42 судится версией на t0, явный experimentId новой версии — 400', async () => {
      // Проба аудита P-E P6: t0 в прошлом, одна сессия и одна квалифицированная
      // заявка в когорте; после t0 владелец утверждает пороги 1/1/0/1.
      const { w: w3, pilot: v1 } = await seedPilotWorld(raw);
      const ref = await seedSession(raw, w3, d('2026-01-20T10:00:00Z'));
      await seedLead(raw, w3, {
        sessionRef: ref,
        receivedAt: d('2026-01-20T11:00:00Z'),
        qualifiedAt: d('2026-01-21T10:00:00Z'),
      });
      await raw.decidedParam(
        w3,
        'd42_thresholds',
        { sessions: 1, qualified: 1, proposals: 0, minSampleForConclusion: 2 },
        'approved',
      );
      const p3 = {
        id: w3.productId,
        accountId: w3.accountId,
        siteId: w3.siteId,
        kind: 'working' as const,
        mode: 'closed' as const,
        status: 'active' as const,
        revision: 1,
      };
      const t3 = <T>(fn: (t: never) => Promise<T>) =>
        s.db.forAccount(w3.accountId).$transaction(fn as never) as Promise<T>;
      // Новая гипотеза пилота после t0 — 400 pilot_started (новая гипотеза —
      // отдельный эксперимент change с будущим окном).
      await expect(
        t3((t) =>
          exps.newVersion(
            t,
            p3,
            v1,
            { hypothesis: 'Та сама гіпотеза, нижчий поріг' },
            ['analyst'],
            'member:m1',
            new Date(),
          ),
        ),
      ).rejects.toMatchObject({
        code: 'PUB_VALIDATION',
        details: { fields: [{ field: 'hypothesis', code: 'pilot_started' }] },
      });
      // Явный конец поздней когорты — можно; пороги — прежние (5), не 1.
      const v2 = await t3((t) =>
        exps.newVersion(
          t,
          p3,
          v1,
          { lateCohortEnd: '2026-04-01T07:00:00.000Z' },
          ['analyst'],
          'member:m1',
          new Date(),
        ),
      );
      expect(v2.row).toMatchObject({ version: 2, status: 'running', t0: T0 });
      expect((v2.row.thresholds as { d42: { qualified: number } }).d42).toEqual(
        {
          sessions: 100,
          qualified: 5,
          proposals: 2,
          minSampleForConclusion: 5,
        },
      );
      const r = await t3((t) =>
        reports.create(t, p3, { kind: 'd42' }, 'member:m1', new Date()),
      );
      expect(r.row.experimentId).toBe(v1);
      const sig = (
        r.row.metrics as {
          signalD42: {
            verdict: string;
            parts: { qualified: { threshold: number; value: number } };
          };
        }
      ).signalD42;
      expect(sig.parts.qualified).toMatchObject({ threshold: 5, value: 1 });
      expect(sig.verdict).toBe('not_met');
      // Обход через явный experimentId новой версии — 400.
      for (const kind of ['d42', 'd72', 'd90']) {
        await expect(
          t3((t) =>
            reports.create(
              t,
              p3,
              { kind, experimentId: v2.row.id },
              'member:m1',
              new Date(),
            ),
          ),
        ).rejects.toMatchObject({
          code: 'PUB_VALIDATION',
          details: {
            fields: [{ field: 'experimentId', code: 'not_pilot_at_t0' }],
          },
        });
      }
      // Явный experimentId — сама версия на t0 — допустим.
      const same = await t3((t) =>
        reports.create(
          t,
          p3,
          { kind: 'd72', experimentId: v1 },
          'member:m1',
          new Date(),
        ),
      );
      expect(same.row.experimentId).toBe(v1);
    });

    it('новая версия change-эксперимента после начала окна — только с новым будущим окном (проба P9)', async () => {
      const { w: w4 } = await seedPilotWorld(raw);
      const p4 = {
        id: w4.productId,
        accountId: w4.accountId,
        siteId: w4.siteId,
        kind: 'working' as const,
        mode: 'closed' as const,
        status: 'active' as const,
        revision: 1,
      };
      const e = await raw.experiment(w4, {
        key: 'cta-old',
        kind: 'change',
        registeredAt: d('2026-02-01T08:00:00Z'),
        windowStart: d('2026-02-02T08:00:00Z'),
        windowEnd: d('2026-02-20T08:00:00Z'),
        status: 'running',
        appliedAt: d('2026-02-02T08:00:00Z'),
      });
      const t4 = <T>(fn: (t: never) => Promise<T>) =>
        s.db.forAccount(w4.accountId).$transaction(fn as never) as Promise<T>;
      const nv = (body: Record<string, unknown>) =>
        t4((t) =>
          exps.newVersion(t, p4, e, body, ['analyst'], 'member:m1', new Date()),
        );
      await expect(
        nv({ hypothesis: 'Інша гіпотеза після перегляду даних' }),
      ).rejects.toMatchObject({
        code: 'PUB_VALIDATION',
        details: {
          fields: [{ field: 'windowStart', code: 'before_registration' }],
        },
      });
      await expect(
        nv({
          hypothesis: 'Інша гіпотеза',
          windowStart: '2026-02-10T08:00:00.000Z',
        }),
      ).rejects.toMatchObject({ code: 'PUB_VALIDATION' });
      const start = new Date(Date.now() + 86_400_000);
      const ok = await nv({
        hypothesis: 'Інша гіпотеза — нове вікно',
        windowStart: start.toISOString(),
        windowEnd: new Date(start.getTime() + 14 * 86_400_000).toISOString(),
      });
      expect(ok.row).toMatchObject({
        version: 2,
        status: 'registered',
        windowStart: start,
      });
      const old = await s.prisma.pubExperiment.findUniqueOrThrow({
        where: { id: e },
      });
      expect(old.status).toBe('superseded');
    });
  },
);
