import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { SitesDb } from '../../prisma/sites-db.service';
import { AccountMembership } from '../site-core/account/roles';
import { QaCatalogService } from './qa-catalog.service';
import { QaPlanService } from './qa-plan.service';
import { QaRunService } from './qa-run.service';
const ciDescribe = process.env.CI === 'true' ? describe : describe.skip;
ciDescribe(
  'QA plans: frozen versions, RBAC, assignment and idempotent matrix runs',
  () => {
    let prisma: PrismaService,
      catalog: QaCatalogService,
      plans: QaPlanService,
      runs: QaRunService,
      account: string,
      site: string,
      caseId: string;
    const member = (id = account, qa = 'admin') =>
      ({
        accountId: id,
        memberId: 'plan-test',
        role: 'operator',
        productRoles: { qa, assist: 'none', assistAdmin: 'none' },
      }) as AccountMembership;
    const casePayload = (title = 'Original') => ({
      title,
      purpose: '',
      preconditions: '',
      steps: [{ action: 'Open demo', expected: 'Success' }],
      type: 'manual',
      priority: 'normal',
      tags: ['onboarding'],
      requirementIds: ['REQ-LOGIN'],
      archived: false,
    });
    const body = () => ({
      title: 'Regression',
      suite: 'Onboarding',
      description: 'Synthetic',
      caseIds: [caseId],
      environments: [
        {
          name: 'Desktop RU',
          browser: 'Chromium',
          device: 'Desktop',
          theme: 'dark',
          locale: 'ru',
          viewport: '1280x720',
        },
        {
          name: 'Mobile EN',
          browser: 'WebKit',
          device: 'Mobile',
          theme: 'light',
          locale: 'en',
          viewport: '390x844',
        },
      ],
      assigneeMemberId: null,
      archived: false,
    });
    beforeAll(async () => {
      const url = new URL(process.env.SITES_DATABASE_URL ?? 'http://invalid');
      if (url.hostname !== 'localhost' || url.pathname !== '/sites')
        throw new Error('isolated localhost/sites only');
      prisma = new PrismaService();
      catalog = new QaCatalogService(new SitesDb(prisma));
      plans = new QaPlanService(catalog);
      runs = new QaRunService(catalog);
      account = (
        await prisma.siteAccount.create({ data: { verifyToken: randomUUID() } })
      ).id;
      site = (
        await prisma.site.create({
          data: { accountId: account, name: 'QA plans' },
        })
      ).id;
      caseId = (
        await catalog.create(member(), site, {
          caseKey: 'QA-PLAN-CASE',
          payload: casePayload(),
        })
      ).id;
    }, 30000);
    afterAll(async () => {
      if (prisma) {
        await prisma.siteAccount.deleteMany({ where: { id: account } });
        await prisma.$disconnect();
      }
    });
    it('pins the exact case version, environment, plan version and empty result', async () => {
      const p = await plans.create(member(), site, {
        planKey: 'PLAN-MATRIX',
        payload: body(),
      });
      await catalog.replace(member(), site, caseId, {
        expectedVersion: 1,
        payload: casePayload('Changed'),
      });
      const start = {
        expectedVersion: 1,
        environmentIndex: 1,
        requestId: randomUUID(),
      };
      const a = await plans.start(member(), site, p.id, start),
        b = await plans.start(member(), site, p.id, start);
      expect(a.id).toBe(b.id);
      expect(b.replayed).toBe(true);
      const read = await runs.get(member(), site, a.id);
      expect(read.snapshot).toMatchObject([
        { version: 1, payload: { title: 'Original' } },
      ]);
      expect(read.context).toMatchObject({
        planVersion: 1,
        environment: { device: 'Mobile', viewport: '390x844', locale: 'en' },
      });
      expect(read.summary).toMatchObject({
        passed: 0,
        notRun: 1,
        complete: false,
      });
      await expect(
        plans.start(member(), site, p.id, { ...start, environmentIndex: 0 }),
      ).rejects.toMatchObject({ status: 409 });
      const fresh = await plans.start(member(), site, p.id, {
        ...start,
        environmentIndex: 0,
        requestId: randomUUID(),
      });
      expect(fresh.id).not.toBe(a.id);
    });
    it('CAS keeps immutable history and reports a stale save', async () => {
      const p = await plans.create(member(), site, {
        planKey: 'PLAN-CAS',
        payload: body(),
      });
      const results = await Promise.allSettled(
        ['A', 'B'].map((title) =>
          plans.replace(member(), site, p.id, {
            expectedVersion: 1,
            payload: { ...body(), title },
          }),
        ),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(
        (results.find((r) => r.status === 'rejected') as PromiseRejectedResult)
          .reason.status,
      ).toBe(409);
      const history = await plans.history(member(), site, p.id);
      expect(history.items.map((r) => r.version)).toEqual([2, 1]);
      await expect(
        prisma.qaPlanRevision.updateMany({
          where: { planId: p.id },
          data: { version: 99 },
        }),
      ).rejects.toThrow();
      await expect(
        plans.start(member(), site, p.id, {
          expectedVersion: 1,
          environmentIndex: 0,
          requestId: randomUUID(),
        }),
      ).rejects.toMatchObject({ status: 409 });
    });
    it('viewer reads but cannot write, and foreign tenants cannot resolve a plan', async () => {
      const p = await plans.create(member(), site, {
        planKey: 'PLAN-ACCESS',
        payload: body(),
      });
      expect((await plans.get(member(account, 'viewer'), site, p.id)).id).toBe(
        p.id,
      );
      await expect(
        plans.create(member(account, 'viewer'), site, {
          planKey: 'PLAN-FORBIDDEN',
          payload: body(),
        }),
      ).rejects.toMatchObject({ status: 403 });
      const other = (
        await prisma.siteAccount.create({ data: { verifyToken: randomUUID() } })
      ).id;
      await expect(plans.get(member(other), site, p.id)).rejects.toMatchObject({
        status: 404,
      });
      await prisma.siteAccount.delete({ where: { id: other } });
    });
    it('requires a same-account QA assignee and rechecks revoked rights at start', async () => {
      const assigned = await prisma.siteAccountMember.create({
        data: {
          accountId: account,
          telegramId: 999999991n,
          role: 'operator',
          productRoles: { qa: 'viewer' },
        },
      });
      const p = await plans.create(member(), site, {
        planKey: 'PLAN-ASSIGNED',
        payload: { ...body(), assigneeMemberId: assigned.id },
      });
      await prisma.siteAccountMember.update({
        where: { id: assigned.id },
        data: { productRoles: { qa: 'none' } },
      });
      await expect(
        plans.start(member(), site, p.id, {
          expectedVersion: 1,
          environmentIndex: 0,
          requestId: randomUUID(),
        }),
      ).rejects.toMatchObject({ status: 400 });
      await plans.replace(member(), site, p.id, {
        expectedVersion: 1,
        payload: { ...body(), assigneeMemberId: assigned.id, archived: true },
      });
      expect((await plans.get(member(), site, p.id)).archived).toBe(true);
      await expect(
        plans.create(member(), site, {
          planKey: 'PLAN-BAD-ASSIGNEE',
          payload: { ...body(), assigneeMemberId: 'missing' },
        }),
      ).rejects.toMatchObject({ status: 400 });
    });
    it('concurrent start requests produce a single run', async () => {
      const p = await plans.create(member(), site, {
          planKey: 'PLAN-ONCE',
          payload: body(),
        }),
        start = {
          expectedVersion: 1,
          environmentIndex: 0,
          requestId: randomUUID(),
        };
      const result = await Promise.allSettled([
        plans.start(member(), site, p.id, start),
        plans.start(member(), site, p.id, start),
      ]);
      const successes = result.filter(
        (r) => r.status === 'fulfilled',
      ) as PromiseFulfilledResult<
        Awaited<ReturnType<QaPlanService['start']>>
      >[];
      expect(successes.length).toBeGreaterThan(0);
      expect(new Set(successes.map((r) => r.value.id)).size).toBe(1);
      expect(
        await prisma.qaTestRun.count({
          where: { id: successes[0].value.id, accountId: account },
        }),
      ).toBe(1);
    });
  },
);
