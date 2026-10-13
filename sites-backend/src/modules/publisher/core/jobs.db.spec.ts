/**
 * Задания и кроны ядра на базе (P-A1, проектный документ §4.1, §15.1):
 *  - `members-reconcile` через СУЩЕСТВУЮЩИЙ маршрут удаления участника
 *    (`DELETE /sites/account/members/:memberId`, site-core): гранты
 *    закрыты, задачи переназначены владельцу, задача `member_removed`;
 *  - `housekeeping` / `rate-hits-sweep`;
 *  - `/cron/publisher-tick|daily`: CRON_SECRET, задания пакетов, которых
 *    ещё нет, — 501 со списком (не «успех»), задания ядра выполнены;
 *  - без шагов пакетов создание продукта — 501 до записи.
 */
import { randomUUID } from 'crypto';
import * as request from 'supertest';
import { ciDescribe } from '../../../prisma/ci-describe.testing';
import { PubCronRegistry } from '../cron/job-registry';
import { PublisherCronController } from '../cron/publisher-cron.controller';
import { PublisherCronModule } from '../cron/publisher-cron.module';
import {
  seedMembers,
  seedProduct,
  seedSite,
  seedTwoAccounts,
  type SeededMembers,
  type TwoAccounts,
} from '../testing/fixtures.testing';
import {
  IdempotencyHousekeepingJob,
  RateHitsSweepJob,
} from './housekeeping.job';
import {
  MEMBERS_RECONCILE_ACTOR,
  MembersReconcileJob,
} from './members-reconcile.job';
import { AuditService } from './audit';
import { PubContributions } from './contributions';
import { ReviewTasksService } from './review-tasks.service';
import { FakeMemberReassign } from './testing/fake-ports';
import {
  asMember,
  coreStack,
  type CoreStack,
} from './testing/core-stack.testing';

jest.setTimeout(90_000);

ciDescribe('Publisher P-A1: задания ядра и кроны', () => {
  let s: CoreStack;
  let w: TwoAccounts;
  let team: SeededMembers;
  const srv = () => s.app!.getHttpServer();
  const deadline = () => new Date(Date.now() + 30_000);

  beforeAll(async () => {
    s = await coreStack({ http: true, imports: [PublisherCronModule] });
    w = await seedTwoAccounts(s.prisma, { withProducts: true });
    team = await seedMembers(s.prisma, w.a.product!, w.a.owner);
  });
  afterAll(async () => {
    await s.close();
  });

  it('members-reconcile: удаление участника маршрутом site-core → гранты закрыты, задачи владельцу, задача member_removed, доступ закрыт сразу', async () => {
    const p = w.a.product!;
    const op = team.operator;
    const review = s.mod.get(ReviewTasksService);
    await s.db.forAccount(p.accountId).$transaction((tx) =>
      review.open(tx, p, [
        {
          objectType: 'content',
          objectId: 'c-9',
          reason: 'stale_check',
          triggerRef: `t-${randomUUID()}`,
          severity: 'normal',
          assigneeMemberId: op.memberId,
        },
      ]),
    );
    const del = await request(srv())
      .delete(`/sites/account/members/${op.memberId}`)
      .set(asMember(w.a.owner.telegramId, w.a.accountId));
    expect(del.status).toBe(200);
    // доступ закрыт уже на следующем запросе — без задания (гвард не находит членства)
    const gone = await request(srv())
      .get(`/publisher/products/${p.id}`)
      .set(asMember(op.telegramId, w.a.accountId));
    expect(gone.status).toBe(403);
    FakeMemberReassign.calls = [];
    const job = s.mod.get(MembersReconcileJob);
    const r = await job.run({
      now: new Date(),
      deadline: deadline(),
      scope: { siteIds: [p.siteId] },
    });
    expect(r.processed).toBe(1);
    expect(r.pending).toBeUndefined();
    expect(r.details).toMatchObject({
      grantsRevoked: 1,
      tasksReassigned: 1,
    });
    const grants = await s.prisma.pubRoleGrant.findMany({
      where: { productId: p.id, memberId: op.memberId },
    });
    expect(grants.map((g) => [g.revokedBy, g.revokedAt !== null])).toEqual([
      [MEMBERS_RECONCILE_ACTOR, true],
    ]);
    const task = await s.prisma.pubReviewTask.findFirst({
      where: { productId: p.id, objectId: 'c-9' },
    });
    expect(task?.assigneeMemberId).toBe(w.a.owner.memberId);
    const removed = await s.prisma.pubReviewTask.findFirst({
      where: {
        productId: p.id,
        reason: 'member_removed',
        objectId: op.memberId,
      },
    });
    expect(removed).toMatchObject({
      status: 'open',
      assigneeMemberId: w.a.owner.memberId,
    });
    expect(FakeMemberReassign.calls.map((c) => c.key).sort()).toEqual([
      'contents',
      'distribution-actions',
      'leads',
    ]);
    expect(
      FakeMemberReassign.calls.every(
        (c) => c.from === op.memberId && c.to === w.a.owner.memberId,
      ),
    ).toBe(true);
    // повтор — ничего нового
    const again = await job.run({
      now: new Date(),
      deadline: deadline(),
      scope: { siteIds: [p.siteId] },
    });
    expect(again.processed).toBe(0);
    expect(
      await s.prisma.pubReviewTask.count({
        where: {
          productId: p.id,
          reason: 'member_removed',
          objectId: op.memberId,
        },
      }),
    ).toBe(1);
  });

  it('members-reconcile (аудит P2-4): нет вклада переназначения → pending, ничего не тронуто; вклад появился → пара обработана', async () => {
    const p = w.a.product!;
    const t2 = await seedMembers(s.prisma, p, w.a.owner);
    const gone = t2.analyst;
    await s.prisma.siteAccountMember.delete({ where: { id: gone.memberId } });
    const real = s.mod.get(MembersReconcileJob);
    const noReassign = new MembersReconcileJob(
      s.db,
      s.mod.get(AuditService),
      s.mod.get(ReviewTasksService),
      {
        list: (kind: string) => (kind === 'member-reassign' ? [] : []),
      } as unknown as PubContributions,
    );
    const ctx = {
      now: new Date(),
      deadline: deadline(),
      scope: { siteIds: [p.siteId] },
    };
    const r = await noReassign.run(ctx);
    expect(r.processed).toBe(0);
    expect(r.pending?.sort()).toEqual([
      'member-reassign:contents',
      'member-reassign:distribution-actions',
      'member-reassign:leads',
    ]);
    expect(r.details).toMatchObject({ waiting: 1 });
    // ничего не тронуто и не отмечено
    expect(
      await s.prisma.pubRoleGrant.count({
        where: { productId: p.id, memberId: gone.memberId, revokedAt: null },
      }),
    ).toBe(1);
    expect(
      await s.prisma.pubReviewTask.count({
        where: { productId: p.id, objectId: gone.memberId },
      }),
    ).toBe(0);
    // вклады есть — та же пара обрабатывается
    FakeMemberReassign.calls = [];
    const r2 = await real.run({ ...ctx, deadline: deadline() });
    expect(r2.pending).toBeUndefined();
    expect(r2.processed).toBe(1);
    expect(FakeMemberReassign.calls.map((c) => c.from)).toEqual([
      gone.memberId,
      gone.memberId,
      gone.memberId,
    ]);
    expect(
      await s.prisma.pubRoleGrant.count({
        where: { productId: p.id, memberId: gone.memberId, revokedAt: null },
      }),
    ).toBe(0);
  });

  it('members-reconcile (аудит P2-4): роли отозваны ДО удаления участника — задачи и объекты всё равно переназначены, задача member_removed открыта', async () => {
    const p = w.a.product!;
    const t2 = await seedMembers(s.prisma, p, w.a.owner);
    const gone = t2.editor;
    await s.prisma.pubRoleGrant.updateMany({
      where: { productId: p.id, memberId: gone.memberId, revokedAt: null },
      data: {
        revokedAt: new Date(),
        revokedBy: `member:${w.a.owner.memberId}`,
        reason: 'Роль більше не потрібна',
      },
    });
    const review = s.mod.get(ReviewTasksService);
    await s.db.forAccount(p.accountId).$transaction((tx) =>
      review.open(tx, p, [
        {
          objectType: 'content',
          objectId: `c-${randomUUID().slice(0, 6)}`,
          reason: 'stale_check',
          triggerRef: `t-${randomUUID()}`,
          severity: 'normal',
          assigneeMemberId: gone.memberId,
        },
      ]),
    );
    await s.prisma.siteAccountMember.delete({ where: { id: gone.memberId } });
    FakeMemberReassign.calls = [];
    const r = await s.mod.get(MembersReconcileJob).run({
      now: new Date(),
      deadline: deadline(),
      scope: { siteIds: [p.siteId] },
    });
    expect(r.processed).toBe(1);
    expect(r.details).toMatchObject({ grantsRevoked: 0, tasksReassigned: 1 });
    expect(FakeMemberReassign.calls.map((c) => c.key).sort()).toEqual([
      'contents',
      'distribution-actions',
      'leads',
    ]);
    expect(
      await s.prisma.pubReviewTask.count({
        where: {
          productId: p.id,
          status: 'open',
          assigneeMemberId: gone.memberId,
        },
      }),
    ).toBe(0);
    expect(
      await s.prisma.pubReviewTask.count({
        where: {
          productId: p.id,
          reason: 'member_removed',
          objectId: gone.memberId,
        },
      }),
    ).toBe(1);
  });

  it('members-reconcile (аудит P2-4): только отозванные гранты, без задач — объекты всё равно переназначаются вкладами', async () => {
    const p = w.a.product!;
    const t2 = await seedMembers(s.prisma, p, w.a.owner);
    const gone = t2.sales;
    await s.prisma.pubRoleGrant.updateMany({
      where: { productId: p.id, memberId: gone.memberId, revokedAt: null },
      data: {
        revokedAt: new Date(),
        revokedBy: `member:${w.a.owner.memberId}`,
        reason: 'Роль більше не потрібна',
      },
    });
    await s.prisma.siteAccountMember.delete({ where: { id: gone.memberId } });
    FakeMemberReassign.calls = [];
    const r = await s.mod.get(MembersReconcileJob).run({
      now: new Date(),
      deadline: deadline(),
      scope: { siteIds: [p.siteId] },
    });
    expect(r.processed).toBe(1);
    expect(r.details).toMatchObject({ grantsRevoked: 0, tasksReassigned: 0 });
    expect(
      FakeMemberReassign.calls
        .filter((c) => c.from === gone.memberId)
        .map((c) => c.key)
        .sort(),
    ).toEqual(['contents', 'distribution-actions', 'leads']);
  });

  it('housekeeping: ключи идемпотентности с истёкшим expiresAt удаляются, живые — нет; rate-hits-sweep — окна старше часа', async () => {
    const p = w.b.product!;
    const mk = (expiresAt: Date) =>
      s.prisma.$executeRaw`
        INSERT INTO "sites"."pub_idempotency_keys" ("id","accountId","productId","opKey","scope","requestHash","responseStatus","expiresAt","createdAt","createdBy")
        VALUES (${`ik_${randomUUID()}`}, ${p.accountId}, ${p.id}, ${randomUUID()}, 'test', ${'a'.repeat(64)}, 200, ${expiresAt}, ${new Date(expiresAt.getTime() - 120_000)}, 'system:test')`;
    await mk(new Date(Date.now() - 60_000));
    await mk(new Date(Date.now() + 3_600_000));
    const hk = s.mod.get(IdempotencyHousekeepingJob);
    const r = await hk.run({
      now: new Date(),
      deadline: deadline(),
      scope: { siteIds: [p.siteId] },
    });
    expect(r.processed).toBe(1);
    expect(
      await s.prisma.pubIdempotencyKey.count({ where: { productId: p.id } }),
    ).toBe(1);
    await s.prisma.pubRateHit.create({
      data: {
        key: `${p.id}:form:abc`,
        at: new Date(Date.now() - 2 * 3_600_000),
      },
    });
    await s.prisma.pubRateHit.create({
      data: { key: `${p.id}:form:abc`, at: new Date() },
    });
    await s.prisma.pubRateHit.create({
      data: {
        key: `other-product:form:abc`,
        at: new Date(Date.now() - 2 * 3_600_000),
      },
    });
    const sweep = s.mod.get(RateHitsSweepJob);
    const r2 = await sweep.run({
      now: new Date(),
      deadline: deadline(),
      scope: { siteIds: [p.siteId] },
    });
    expect(r2.processed).toBe(1);
    expect(
      await s.prisma.pubRateHit.count({ where: { key: `${p.id}:form:abc` } }),
    ).toBe(1);
    expect(
      await s.prisma.pubRateHit.count({
        where: { key: 'other-product:form:abc' },
      }),
    ).toBe(1);
    await s.prisma.pubRateHit.deleteMany({
      where: { key: 'other-product:form:abc' },
    });
  });

  it('/cron/publisher-tick: без секрета — 401; задания пакетов ещё не подключены — 501 со списком, задания ядра выполнены', async () => {
    expect((await request(srv()).get('/cron/publisher-tick')).status).toBe(401);
    const res = await request(srv())
      .get('/cron/publisher-tick')
      .set('Authorization', 'Bearer cron-secret-for-test');
    expect(res.status).toBe(501);
    expect(res.body.error.code).toBe('PUB_NOT_IMPLEMENTED');
    const jobs = res.body.error.details.jobs as Array<{
      key: string;
      status: string;
      owner: string;
    }>;
    expect(
      jobs
        .filter((j) => j.owner === 'P-A1')
        .map((j) => [j.key, j.status])
        .sort(),
    ).toEqual([
      ['members-reconcile', 'ok'],
      ['rate-hits-sweep', 'ok'],
    ]);
    expect(res.body.error.details.missing).toContainEqual({
      key: 'lead-enrich',
      owner: 'P-D',
    });
    const daily = await request(srv())
      .get('/cron/publisher-daily')
      .set('Authorization', 'Bearer cron-secret-for-test');
    expect(daily.status).toBe(501);
    expect(
      (
        daily.body.error.details.jobs as Array<{ key: string; status: string }>
      ).find((j) => j.key === 'housekeeping')?.status,
    ).toBe('ok');
  });

  it('крон (аудит P3-11): skipped — 503 PUB_BUSY, pending — 501; не «успех»', async () => {
    const report = (status: string) => ({
      schedule: 'tick',
      startedAt: new Date().toISOString(),
      jobs: [{ key: 'members-reconcile', owner: 'P-A1', status }],
      ok: 0,
      errors: 0,
      missing: 0,
      pending: status === 'pending' ? 1 : 0,
      skipped: status === 'skipped' ? 1 : 0,
    });
    const ctl = (status: string) =>
      new PublisherCronController(s.prisma, {
        run: async () => report(status),
      } as unknown as PubCronRegistry);
    await expect(
      ctl('skipped').tick('Bearer cron-secret-for-test'),
    ).rejects.toMatchObject({ code: 'PUB_BUSY' });
    await expect(
      ctl('pending').tick('Bearer cron-secret-for-test'),
    ).rejects.toMatchObject({ code: 'PUB_NOT_IMPLEMENTED' });
    await expect(
      ctl('ok').tick('Bearer cron-secret-for-test'),
    ).resolves.toMatchObject({ ran: true });
  });

  it('создание продукта без шагов пакетов (канал, лимит, эксперимент) — 501 со списком, ничего не записано', async () => {
    const bare = await coreStack({
      http: true,
      fakes: false,
      prisma: s.prisma,
    });
    try {
      const siteId = await seedSite(s.prisma, w.a.accountId);
      const res = await request(bare.app!.getHttpServer())
        .post(`/publisher/sites/${siteId}/product`)
        .set(asMember(w.a.owner.telegramId, w.a.accountId))
        .send({ opKey: randomUUID(), name: 'Без пакетів', kind: 'test' });
      expect(res.status).toBe(501);
      expect(res.body.error).toMatchObject({
        code: 'PUB_NOT_IMPLEMENTED',
        details: {
          step: 'product-init',
          missing: [
            { key: 'site-channel', owner: 'P-C' },
            { key: 'budget-limit', owner: 'P-C' },
            { key: 'pilot-experiment', owner: 'P-E' },
          ],
        },
      });
      expect(await s.prisma.pubProduct.count({ where: { siteId } })).toBe(0);
      // порт без реализации — тоже 501 (бюджетный ключ → BudgetLimitPort P-C)
      const p = await seedProduct(s.prisma, {
        accountId: w.a.accountId,
        kind: 'test',
      });
      const dec = await request(bare.app!.getHttpServer())
        .post(`/publisher/products/${p.id}/parameters/budget_total/decision`)
        .set(asMember(w.a.owner.telegramId, w.a.accountId))
        .send({
          opKey: randomUUID(),
          toStatus: 'approved',
          basis: 'Ліміт затверджено',
          expectedRevision: 1,
        });
      expect(dec.status).toBe(501);
      expect(dec.body.error.details).toMatchObject({
        port: 'PUB_BUDGET_LIMIT_PORT',
        owner: 'P-C',
      });
      expect(
        await s.prisma.pubParameterDecision.count({
          where: { productId: p.id },
        }),
      ).toBe(0);
    } finally {
      await bare.close();
    }
  });
});
