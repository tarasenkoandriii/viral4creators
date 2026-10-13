/**
 * AI Publisher — приёмка P-E: победитель не объявляется (AT-F17-02, ТЗ
 * §23): одна заявка, незакрытое окно или выборка меньше
 * `minSampleForConclusion` (замороженной) — только «невизначено»;
 * «подтверждено/не подтверждено» — 409 `PUB_WINDOW_OPEN`.
 */
import { randomUUID } from 'crypto';
import * as request from 'supertest';
import { ciDescribe } from '../../prisma/ci-describe.testing';
import {
  PubDb,
  connectOwner,
  json,
  type PubWorld,
} from '../../prisma/publisher-schema.testing';
import { asMember } from '../../modules/publisher/core/testing/core-stack.testing';
import { experimentConclusionAllowed } from '../../modules/publisher/reports/metrics/economics';
import {
  T0,
  T42,
  T72,
  T90,
  d,
  seedLead,
  seedSession,
} from '../../modules/publisher/reports/testing/pilot-world.testing';
import {
  reportsStack,
  type ReportsStack,
} from '../../modules/publisher/reports/testing/reports-stack.testing';
import {
  seedMembers,
  seedTwoAccounts,
  type SeededMembers,
  type TwoAccounts,
} from '../../modules/publisher/testing/fixtures.testing';

jest.setTimeout(90_000);
const DAY = 86_400_000;

describe('[AT-F17-02] experimentConclusionAllowed: только закрытое окно и выборка ≥ порога', () => {
  it.each([
    [
      { windowClosed: false, qualifiedUnique: 10, minSample: 5 },
      'inconclusive_only',
    ],
    [
      { windowClosed: true, qualifiedUnique: 1, minSample: 5 },
      'inconclusive_only',
    ],
    [
      { windowClosed: true, qualifiedUnique: 4, minSample: 5 },
      'inconclusive_only',
    ],
    [{ windowClosed: true, qualifiedUnique: 5, minSample: 5 }, 'any'],
    // Пол выборки 2 (аудит P-E S2-6): порог 1 не даёт заключения по одной заявке.
    [
      { windowClosed: true, qualifiedUnique: 1, minSample: 1 },
      'inconclusive_only',
    ],
    [{ windowClosed: true, qualifiedUnique: 2, minSample: 1 }, 'any'],
    [
      { windowClosed: true, qualifiedUnique: 0, minSample: 0 },
      'inconclusive_only',
    ],
  ] as const)('%j → %s', (i, out) => {
    expect(experimentConclusionAllowed(i)).toBe(out);
  });
});

ciDescribe(
  '[AT-F17-02] Одна заявка и открытое окно — система не объявляет победителя',
  () => {
    let s: ReportsStack;
    let w: TwoAccounts;
    let team: SeededMembers;
    let owner: Awaited<ReturnType<typeof connectOwner>>;
    let world: PubWorld;
    const srv = () => s.app!.getHttpServer();
    const as = (k: keyof SeededMembers) =>
      asMember(team[k].telegramId, w.a.accountId);

    beforeAll(async () => {
      s = await reportsStack({ http: true });
      w = await seedTwoAccounts(s.prisma, {
        withProducts: true,
        kind: 'working',
      });
      team = await seedMembers(s.prisma, w.a.product!, w.a.owner);
      owner = await connectOwner();
      const raw = new PubDb(owner);
      world = {
        accountId: w.a.accountId,
        siteId: w.a.siteId,
        productId: w.a.product!.id,
      };
      await raw.openForIntake(world);
      // Одна внешняя квалифицированная заявка в окне эксперимента.
      const ref = await seedSession(raw, world, new Date(Date.now() - 2 * DAY));
      await seedLead(raw, world, {
        sessionRef: ref,
        receivedAt: new Date(Date.now() - DAY),
        qualifiedAt: new Date(Date.now() - DAY / 2),
      });
    });
    afterAll(async () => {
      await owner?.end();
      await s?.close();
    });

    async function runningExperiment(): Promise<string> {
      const start = new Date(Date.now() + 60_000);
      const reg = await request(srv())
        .post(`/publisher/products/${world.productId}/experiments`)
        .set(as('analyst'))
        .send({
          opKey: randomUUID(),
          key: `adapt-${randomUUID().slice(0, 8)}`,
          hypothesis: 'Картки замість поста дадуть більше звернень',
          change: 'Формат адаптації',
          metric: 'Кваліфіковані prospect_id',
          expectedSignal: 'Більше за пост',
          stopConditions: 'Ліміт',
          windowStart: start.toISOString(),
          windowEnd: new Date(start.getTime() + 7 * DAY).toISOString(),
          limitMinor: '10000',
        });
      expect(reg.status).toBe(201);
      await request(srv())
        .post(
          `/publisher/products/${world.productId}/experiments/${reg.body.data.id}/apply`,
        )
        .set(as('analyst'))
        .send({ opKey: randomUUID() });
      return reg.body.data.id as string;
    }

    it('«підтверджено» и «не підтверджено» при открытом окне — 409 PUB_WINDOW_OPEN с причинами; «невизначено» — 200', async () => {
      const id = await runningExperiment();
      for (const conclusion of ['supported', 'not_supported']) {
        const r = await request(srv())
          .post(
            `/publisher/products/${world.productId}/experiments/${id}/conclude`,
          )
          .set(as('analyst'))
          .send({
            opKey: randomUUID(),
            conclusion,
            reason: 'Одна заявка — переможець',
            decision: 'scale',
          });
        expect([conclusion, r.status, r.body.error?.code]).toEqual([
          conclusion,
          409,
          'PUB_WINDOW_OPEN',
        ]);
        expect(r.body.error.details).toMatchObject({
          windowClosed: false,
          minSampleForConclusion: 5,
          allowed: ['inconclusive'],
        });
      }
      const ok = await request(srv())
        .post(
          `/publisher/products/${world.productId}/experiments/${id}/conclude`,
        )
        .set(as('analyst'))
        .send({
          opKey: randomUUID(),
          conclusion: 'inconclusive',
          reason: 'Одна заявка, вікно не закрите',
          decision: 'continue_limited',
        });
      expect(ok.status).toBe(200);
      expect(ok.body.data).toMatchObject({
        status: 'concluded',
        conclusion: 'inconclusive',
      });
    });

    it('пилот без t0 (окно не началось) — тоже только «невизначено»; повтор заключения — 409 перехода', async () => {
      const pilot = await new PubDb(owner).experiment(world, {
        key: 'pilot',
        kind: 'pilot',
        status: 'running',
        registeredAt: new Date(Date.now() - 60_000),
        appliedAt: new Date(),
        windowStart: new Date(),
        windowEnd: new Date(Date.now() + 90 * DAY),
      });
      const r = await request(srv())
        .post(
          `/publisher/products/${world.productId}/experiments/${pilot}/conclude`,
        )
        .set(as('product_owner'))
        .send({
          opKey: randomUUID(),
          conclusion: 'supported',
          reason: 'Спроба оголосити успіх',
          decision: 'scale',
        });
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('PUB_WINDOW_OPEN');
      const id = await runningExperiment();
      await request(srv())
        .post(
          `/publisher/products/${world.productId}/experiments/${id}/conclude`,
        )
        .set(as('analyst'))
        .send({
          opKey: randomUUID(),
          conclusion: 'inconclusive',
          reason: 'Перше',
          decision: 'fix_stage',
        });
      const again = await request(srv())
        .post(
          `/publisher/products/${world.productId}/experiments/${id}/conclude`,
        )
        .set(as('analyst'))
        .send({
          opKey: randomUUID(),
          conclusion: 'inconclusive',
          reason: 'Друге',
          decision: 'fix_stage',
        });
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe('PUB_TRANSITION_INVALID');
    });
  },
);

ciDescribe(
  '[AT-F17-02] [AT-CORE-23] Пилот после t0: заключение — по порогам версии на t0 и не по одной заявке',
  () => {
    let s: ReportsStack;
    let owner: Awaited<ReturnType<typeof connectOwner>>;
    let raw: PubDb;
    beforeAll(async () => {
      s = await reportsStack({ http: true });
      owner = await connectOwner();
      raw = new PubDb(owner);
    });
    afterAll(async () => {
      await owner?.end();
      await s?.close();
    });

    /** Утверждённое значение параметра (новая версия с решением, если есть). */
    async function setParam(world: PubWorld, key: string, value: unknown) {
      const cur = await s.prisma.pubParameter.findFirst({
        where: { productId: world.productId, key },
      });
      if (!cur) {
        await raw.decidedParam(world, key, value, 'approved');
        return;
      }
      await raw.child('pub_parameter_decisions', world, {
        parameterKey: key,
        version: cur.version + 1,
        fromStatus: cur.status,
        toStatus: 'approved',
        valueSnapshot: value,
        decidedBy: 'member:m1',
        basis: 'Рішення власника (тест)',
        dependentStages: [],
      });
      await raw.upd('pub_parameters', cur.id, {
        value,
        version: cur.version + 1,
        status: 'approved',
        approvedBy: 'member:m1',
        approvedAt: new Date(),
      });
    }

    /** Продукт с участниками, пилотом (t0 в прошлом) и N квалифицированными в когорте. */
    async function pilotWithLeads(
      d42: Record<string, number>,
      qualified: number,
    ) {
      const w = await seedTwoAccounts(s.prisma, {
        withProducts: true,
        kind: 'working',
      });
      const team = await seedMembers(s.prisma, w.a.product!, w.a.owner);
      const world: PubWorld = {
        accountId: w.a.accountId,
        siteId: w.a.siteId,
        productId: w.a.product!.id,
      };
      await raw.openForIntake(world);
      await setParam(world, 'analytics_storage', json('session'));
      await raw.child('pub_integrations', world, {
        kind: 'events_collector',
        status: 'connected',
        manual: true,
        lastSuccessAt: new Date(),
        staleAfterHours: 48,
      });
      const pilot = await raw.experiment(world, {
        key: 'pilot',
        kind: 'pilot',
        registeredAt: d('2026-01-01T08:00:00Z'),
        windowStart: T0,
        windowEnd: T90,
        t0: T0,
        t42: T42,
        t72: T72,
        t90: T90,
        status: 'running',
        appliedAt: T0,
        thresholds: {
          d42,
          d90: { indexedPages: 3, pagesTotal: 6, pagesWithClicks28d: 2 },
          allowedCpl: { contributionMinor: null, pPayBp: null, shareBp: null },
          lateCohort: { closeAfterDays: 30, explicitEndRequired: true },
          versions: {},
        },
      });
      for (let k = 0; k < qualified; k++) {
        const ref = await seedSession(
          raw,
          world,
          new Date(d('2026-01-20T10:00:00Z').getTime() + k * DAY),
        );
        await seedLead(raw, world, {
          sessionRef: ref,
          receivedAt: new Date(d('2026-01-20T11:00:00Z').getTime() + k * DAY),
          qualifiedAt: new Date(d('2026-01-21T10:00:00Z').getTime() + k * DAY),
        });
      }
      const as = asMember(team.analyst.telegramId, w.a.accountId);
      const post = (path: string, body: Record<string, unknown>) =>
        request(s.app!.getHttpServer())
          .post(`/publisher/products/${world.productId}${path}`)
          .set(as)
          .send({ opKey: randomUUID(), ...body });
      return { world, pilot, post };
    }

    it('порог версии на t0 = 1 (старые данные): одна заявка — 409; две — заключение разрешено (пол 2)', async () => {
      const one = await pilotWithLeads(
        { sessions: 1, qualified: 1, proposals: 0, minSampleForConclusion: 1 },
        1,
      );
      const r1 = await one.post(`/experiments/${one.pilot}/conclude`, {
        conclusion: 'supported',
        reason: 'Одна заявка — підтверджено',
        decision: 'stop_purchases',
      });
      expect([r1.status, r1.body.error?.code]).toEqual([
        409,
        'PUB_WINDOW_OPEN',
      ]);
      expect(r1.body.error.details).toMatchObject({
        windowClosed: true,
        qualifiedUnique: 1,
      });
      const two = await pilotWithLeads(
        { sessions: 1, qualified: 1, proposals: 0, minSampleForConclusion: 1 },
        2,
      );
      const r2 = await two.post(`/experiments/${two.pilot}/conclude`, {
        conclusion: 'supported',
        reason: 'Дві заявки, вікно закрите',
        decision: 'stop_purchases',
      });
      expect(r2.status).toBe(200);
      expect(r2.body.data).toMatchObject({
        status: 'concluded',
        conclusion: 'supported',
      });
    });

    it('после снижения порога новая версия пилота (только lateCohortEnd) заключается по порогам версии на t0: 2 заявки < 5 — 409; гипотеза после t0 — 400', async () => {
      const x = await pilotWithLeads(
        {
          sessions: 100,
          qualified: 5,
          proposals: 2,
          minSampleForConclusion: 5,
        },
        2,
      );
      await setParam(x.world, 'd42_thresholds', {
        sessions: 1,
        qualified: 1,
        proposals: 0,
        minSampleForConclusion: 2,
      });
      const bad = await x.post(`/experiments/${x.pilot}/version`, {
        hypothesis: 'Нижчий поріг після старту',
      });
      expect(bad.status).toBe(400);
      expect(bad.body.error.details.fields).toEqual([
        { field: 'hypothesis', code: 'pilot_started' },
      ]);
      const v2 = await x.post(`/experiments/${x.pilot}/version`, {
        lateCohortEnd: '2026-04-01T07:00:00.000Z',
      });
      expect(v2.status).toBe(201);
      expect(v2.body.data.thresholds.d42.minSampleForConclusion).toBe(5);
      const c = await x.post(`/experiments/${v2.body.data.id}/conclude`, {
        conclusion: 'supported',
        reason: 'Спроба після зниження порогу',
        decision: 'scale',
      });
      expect([c.status, c.body.error?.code]).toEqual([409, 'PUB_WINDOW_OPEN']);
      expect(c.body.error.details).toMatchObject({
        qualifiedUnique: 2,
        minSampleForConclusion: 5,
      });
      const rep = await x.post('/reports', {
        kind: 'd42',
        experimentId: v2.body.data.id,
      });
      expect(rep.status).toBe(400);
      expect(rep.body.error.details.fields).toEqual([
        { field: 'experimentId', code: 'not_pilot_at_t0' },
      ]);
    });
  },
);
