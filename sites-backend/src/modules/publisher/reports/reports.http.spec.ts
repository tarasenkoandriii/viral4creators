/**
 * Маршруты P-E по HTTP на базе (проектный документ §11.3): контракт
 * `contracts/reports-api.ts` ↔ контроллер, роли матрицы §4.2, труд со
 * ставкой, копии и восстановление (apply — только владелец кабинета),
 * идемпотентность `opKey`, CSV с аудитом выгрузки.
 */
import { randomUUID } from 'crypto';
import * as request from 'supertest';
import { ciDescribe } from '../../../prisma/ci-describe.testing';
import { PubDb, connectOwner } from '../../../prisma/publisher-schema.testing';
import { REPORTS_ROUTES } from '../contracts/reports-api';
import { enumerateControllers } from '../core/route-enumerator';
import { asMember } from '../core/testing/core-stack.testing';
import {
  seedMembers,
  seedSite,
  seedTwoAccounts,
  type SeededMembers,
  type TwoAccounts,
} from '../testing/fixtures.testing';
import { PublisherReportsController } from './reports.controller';
import {
  reportsStack,
  type ReportsStack,
} from './testing/reports-stack.testing';
import { TD10_SECRET } from './testing/td10.testing';

jest.setTimeout(120_000);

describe('contracts/reports-api ↔ контроллер P-E', () => {
  it('REPORTS_ROUTES = маршруты PublisherReportsController (метод, путь, действие)', () => {
    const fromController = enumerateControllers([
      PublisherReportsController as never,
    ])
      .map(
        (r) =>
          `${r.method} ${r.path} ${[...(r.pubActions ?? [])].sort().join('|')}`,
      )
      .sort();
    const fromContract = Object.values(REPORTS_ROUTES)
      .map(
        (r) =>
          `${r.method} ${r.path} ${[...(Array.isArray(r.action) ? r.action : [r.action])].sort().join('|')}`,
      )
      .sort();
    expect(fromController).toEqual(fromContract);
  });
});

ciDescribe('Publisher P-E: маршруты по HTTP', () => {
  let s: ReportsStack;
  let w: TwoAccounts;
  let team: SeededMembers;
  let owner: Awaited<ReturnType<typeof connectOwner>>;
  const saved = process.env.ASSIST_SECRETS_KEY;
  const srv = () => s.app!.getHttpServer();
  const as = (k: keyof SeededMembers) =>
    asMember(team[k].telegramId, w.a.accountId);
  const pid = () => w.a.product!.id;
  const url = (p: string) => `/publisher/products/${pid()}${p}`;

  beforeAll(async () => {
    process.env.ASSIST_SECRETS_KEY = TD10_SECRET;
    s = await reportsStack({ http: true });
    w = await seedTwoAccounts(s.prisma, { withProducts: true });
    team = await seedMembers(s.prisma, w.a.product!, w.a.owner);
    owner = await connectOwner();
  });
  afterAll(async () => {
    if (saved === undefined) delete process.env.ASSIST_SECRETS_KEY;
    else process.env.ASSIST_SECRETS_KEY = saved;
    await owner?.end();
    await s?.close();
  });

  describe('учёт времени', () => {
    const entry = (over: Record<string, unknown> = {}) => ({
      opKey: randomUUID(),
      role: 'analyst',
      task: 'Аналітика тижня 1',
      minutes: 90,
      workDate: '2026-10-21',
      category: 'analytics_ops',
      ...over,
    });

    it('своё время: 201, ставка не утверждена → null; повтор opKey — тот же ответ (в ключе без `task`)', async () => {
      const b = entry();
      const r = await request(srv())
        .post(url('/time-entries'))
        .set(as('analyst'))
        .send(b);
      expect(r.status).toBe(201);
      expect(r.body.data).toMatchObject({
        memberId: team.analyst.memberId,
        role: 'analyst',
        minutes: 90,
        workDate: '2026-10-21',
        isInvestment: false,
        rateMinorPerHour: null,
        revision: 1,
      });
      const again = await request(srv())
        .post(url('/time-entries'))
        .set(as('analyst'))
        .send(b);
      expect(again.status).toBe(201);
      expect(again.body.data.id).toBe(r.body.data.id);
      const key = await s.prisma.pubIdempotencyKey.findFirstOrThrow({
        where: { accountId: w.a.accountId, opKey: b.opKey },
      });
      expect(JSON.stringify(key.responseBody)).not.toMatch(/task/);
    });

    it('роль не своя — 400; viewer — 403; чужая запись — только product_owner; телефон в задаче — 400 pii', async () => {
      expect(
        (
          await request(srv())
            .post(url('/time-entries'))
            .set(as('analyst'))
            .send(entry({ role: 'editor' }))
        ).body.error.details.fields,
      ).toEqual([{ field: 'role', code: 'not_held' }]);
      expect(
        (
          await request(srv())
            .post(url('/time-entries'))
            .set(as('viewer'))
            .send(entry({ role: 'viewer' }))
        ).status,
      ).toBe(403);
      const other = await request(srv())
        .post(url('/time-entries'))
        .set(as('analyst'))
        .send(entry({ memberId: team.editor.memberId, role: 'editor' }));
      expect([other.status, other.body.error.code]).toEqual([
        403,
        'PUB_ROLE_REQUIRED',
      ]);
      const po = await request(srv())
        .post(url('/time-entries'))
        .set(as('product_owner'))
        .send(
          entry({
            memberId: team.editor.memberId,
            role: 'editor',
            category: 'setup',
            task: 'Налаштування CMS',
          }),
        );
      expect(po.status).toBe(201);
      expect(po.body.data).toMatchObject({
        memberId: team.editor.memberId,
        isInvestment: true,
      });
      const pii = await request(srv())
        .post(url('/time-entries'))
        .set(as('analyst'))
        .send(entry({ task: 'Подзвонити +380 67 123 45 67' }));
      expect(pii.body.error.details.fields).toEqual([
        { field: 'task', code: 'pii' },
      ]);
    });

    it('утверждённая ставка роли фиксируется в записи с версией параметра; PATCH — CAS', async () => {
      const raw = new PubDb(owner);
      const world = {
        accountId: w.a.accountId,
        siteId: w.a.siteId,
        productId: pid(),
      };
      const rates = {
        currency: 'UAH',
        rates: {
          analyst: 40_000,
          product_owner: null,
          editor: null,
          operator: null,
          sales: null,
          viewer: null,
          admin: null,
        },
      };
      await raw.child('pub_parameter_decisions', world, {
        parameterKey: 'rates_by_role',
        version: 2,
        fromStatus: 'assumption',
        toStatus: 'approved',
        valueSnapshot: rates,
        decidedBy: 'member:m1',
        basis: 'Ставки ролей затверджено',
        dependentStages: ['reports'],
      });
      const p = await s.prisma.pubParameter.findFirstOrThrow({
        where: { productId: pid(), key: 'rates_by_role' },
      });
      await raw.upd('pub_parameters', p.id, {
        value: rates,
        version: 2,
        status: 'approved',
        approvedBy: 'member:m1',
        approvedAt: new Date(),
      });
      const r = await request(srv())
        .post(url('/time-entries'))
        .set(as('analyst'))
        .send(entry());
      expect(r.body.data).toMatchObject({
        rateMinorPerHour: '40000',
        rateParamVersion: 2,
      });
      const patch = await request(srv())
        .patch(url(`/time-entries/${r.body.data.id}`))
        .set(as('analyst'))
        .send({ opKey: randomUUID(), expectedRevision: 1, minutes: 120 });
      expect(patch.status).toBe(200);
      expect(patch.body.data).toMatchObject({ minutes: 120, revision: 2 });
      const stale = await request(srv())
        .patch(url(`/time-entries/${r.body.data.id}`))
        .set(as('analyst'))
        .send({ opKey: randomUUID(), expectedRevision: 1, minutes: 30 });
      expect([stale.status, stale.body.error.code]).toEqual([
        409,
        'PUB_CONFLICT',
      ]);
    });

    it('список: участник видит своё, product_owner — всех; CSV — с аудитом export', async () => {
      const mine = await request(srv())
        .get(url('/time-entries'))
        .set(as('analyst'));
      expect(
        mine.body.data.items.every(
          (x: { memberId: string }) => x.memberId === team.analyst.memberId,
        ),
      ).toBe(true);
      const all = await request(srv())
        .get(url('/time-entries'))
        .set(as('product_owner'));
      expect(
        new Set(
          all.body.data.items.map((x: { memberId: string }) => x.memberId),
        ).size,
      ).toBe(2);
      const csv = await request(srv())
        .get(url('/time-entries?format=csv'))
        .set(as('product_owner'));
      expect(csv.status).toBe(200);
      expect(csv.text.split('\r\n')[0]).toBe(
        'id,memberId,role,workDate,minutes,category,isInvestment,rateMinorPerHour,featureId,contentId,createdAt',
      );
      expect(csv.text).not.toMatch(/Аналітика тижня/); // текст задачи в выгрузку не идёт
      const bad = await request(srv())
        .get(url('/time-entries?format=xml'))
        .set(as('product_owner'));
      expect(bad.status).toBe(400);
    });
  });

  describe('копии и восстановление', () => {
    let backupId: string;

    it('ручная копия — admin; viewer — 403; список без пути blob', async () => {
      expect(
        (
          await request(srv())
            .post(url('/backups'))
            .set(as('viewer'))
            .send({ opKey: randomUUID(), kind: 'manual' })
        ).status,
      ).toBe(403);
      const r = await request(srv())
        .post(url('/backups'))
        .set(as('admin'))
        .send({ opKey: randomUUID(), kind: 'manual' });
      expect(r.status).toBe(201);
      expect(r.body.data).toMatchObject({
        kind: 'manual',
        status: 'ok',
        keyVersion: 'v1',
      });
      backupId = r.body.data.id;
      const list = await request(srv()).get(url('/backups')).set(as('admin'));
      expect(list.body.data.items[0].id).toBe(backupId);
      expect(JSON.stringify(list.body)).not.toMatch(/blobPath|publisher\//);
    });

    it('PUBLISHER_BACKUP_DISABLED=true — ручная копия 501 (не «успех»)', async () => {
      process.env.PUBLISHER_BACKUP_DISABLED = 'true';
      try {
        const r = await request(srv())
          .post(url('/backups'))
          .set(as('admin'))
          .send({ opKey: randomUUID(), kind: 'manual' });
        expect([r.status, r.body.error.code]).toEqual([
          501,
          'PUB_NOT_IMPLEMENTED',
        ]);
      } finally {
        delete process.env.PUBLISHER_BACKUP_DISABLED;
      }
    });

    it('dry-run — admin; apply — только владелец кабинета (admin — 403); повтор apply с тем же opKey — то же восстановление', async () => {
      const dry = await request(srv())
        .post(url(`/backups/${backupId}/restore`))
        .set(as('admin'))
        .send({ opKey: randomUUID(), mode: 'dry_run' });
      expect(dry.status).toBe(201);
      expect(dry.body.data).toMatchObject({
        mode: 'dry_run',
        status: 'done',
        report: { ok: true },
      });
      const target = await seedSite(s.prisma, w.a.accountId);
      const denied = await request(srv())
        .post(url(`/backups/${backupId}/restore`))
        .set(as('admin'))
        .send({
          opKey: randomUUID(),
          mode: 'apply_new_product',
          targetSiteId: target,
        });
      expect([
        denied.status,
        denied.body.error.code,
        denied.body.error.details.action,
      ]).toEqual([403, 'PUB_ROLE_REQUIRED', 'restore.apply']);
      const body = {
        opKey: randomUUID(),
        mode: 'apply_new_product',
        targetSiteId: target,
      };
      const ok = await request(srv())
        .post(url(`/backups/${backupId}/restore`))
        .set(as('accountOwner'))
        .send(body);
      expect(ok.status).toBe(201);
      expect(ok.body.data).toMatchObject({
        mode: 'apply_new_product',
        status: 'done',
      });
      const again = await request(srv())
        .post(url(`/backups/${backupId}/restore`))
        .set(as('accountOwner'))
        .send(body);
      expect(again.body.data).toMatchObject({
        id: ok.body.data.id,
        status: 'done',
      });
      const restored = await s.prisma.pubProduct.findFirstOrThrow({
        where: { id: ok.body.data.targetProductId },
      });
      expect(restored).toMatchObject({
        kind: 'restored',
        mode: 'closed',
        siteId: target,
      });
      const view = await request(srv())
        .get(url(`/restores/${ok.body.data.id}`))
        .set(as('admin'));
      expect(view.body.data.report).toMatchObject({
        mode: 'apply_new_product',
        targetProductId: restored.id,
      });
      // Чужой кабинет — 404 (как «нет»).
      const foreign = await request(srv())
        .post(
          `/publisher/products/${w.b.product!.id}/backups/${backupId}/restore`,
        )
        .set(as('accountOwner'))
        .send({ opKey: randomUUID(), mode: 'dry_run' });
      expect(foreign.status).toBe(404);
    });
  });

  describe('отчёты', () => {
    it('снимок ad_hoc, список, карточка, CSV и предварительный расчёт; viewer читает, но не создаёт', async () => {
      const b = {
        opKey: randomUUID(),
        kind: 'ad_hoc',
        periodStart: '2026-09-01T00:00:00.000Z',
        periodEnd: '2026-09-08T00:00:00.000Z',
      };
      expect(
        (await request(srv()).post(url('/reports')).set(as('viewer')).send(b))
          .status,
      ).toBe(403);
      const r = await request(srv())
        .post(url('/reports'))
        .set(as('analyst'))
        .send(b);
      expect(r.status).toBe(201);
      const again = await request(srv())
        .post(url('/reports'))
        .set(as('analyst'))
        .send(b);
      expect(again.body.data.id).toBe(r.body.data.id);
      const list = await request(srv())
        .get(url('/reports?kind=ad_hoc'))
        .set(as('viewer'));
      expect(list.body.data.items.map((x: { id: string }) => x.id)).toContain(
        r.body.data.id,
      );
      const one = await request(srv())
        .get(url(`/reports/${r.body.data.id}`))
        .set(as('viewer'));
      expect(one.body.data).toMatchObject({
        id: r.body.data.id,
        kind: 'ad_hoc',
        superseded: false,
      });
      // Причину «позднее решение/оплата/идентификация» ставит только
      // report-staleness; человек — «вручную» (аудит P-E S3-10).
      const forged = await request(srv())
        .post(url(`/reports/${r.body.data.id}/recompute`))
        .set(as('analyst'))
        .send({ opKey: randomUUID(), reason: 'late_decision' });
      expect(forged.status).toBe(400);
      expect(forged.body.error.details.fields).toEqual([
        { field: 'reason', code: 'system_only' },
      ]);
      const re = await request(srv())
        .post(url(`/reports/${r.body.data.id}/recompute`))
        .set(as('analyst'))
        .send({ opKey: randomUUID() });
      expect(re.status).toBe(201);
      expect(re.body.data).toMatchObject({
        supersedesReportId: r.body.data.id,
        recomputeReason: 'manual',
      });
      const one2 = await request(srv())
        .get(url(`/reports/${r.body.data.id}`))
        .set(as('viewer'));
      expect(one2.body.data.superseded).toBe(true);
      const csv = await request(srv())
        .get(url('/reports?format=csv'))
        .set(as('viewer'));
      expect(csv.status).toBe(200);
      const prev = await request(srv())
        .get(url('/economics/preview'))
        .set(as('analyst'));
      expect(prev.status).toBe(200);
      expect(prev.body.data).toMatchObject({
        preliminary: true,
        kind: 'ad_hoc',
      });
      expect(
        (await request(srv()).get(url('/economics/preview')).set(as('viewer')))
          .status,
      ).toBe(403);
    });
  });
});
