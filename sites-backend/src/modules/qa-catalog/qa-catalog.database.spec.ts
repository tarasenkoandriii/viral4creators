import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { SitesDb } from '../../prisma/sites-db.service';
import { AccountMembership } from '../site-core/account/roles';
import { QaCatalogService } from './qa-catalog.service';
const ciDescribe = process.env.CI === 'true' ? describe : describe.skip;
ciDescribe('QA catalog on isolated CI Postgres', () => {
  let prisma: PrismaService;
  let service: QaCatalogService;
  let accountA: string,
    accountB: string,
    siteA: string,
    siteB: string,
    caseId: string;
  const member = (accountId: string) =>
    ({
      accountId,
      memberId: 'qa-fixture',
      role: 'owner',
      productRoles: { qa: 'admin', assist: 'none', assistAdmin: 'none' },
    }) as AccountMembership;
  const payload = (title = 'Login') => ({
    title,
    purpose: '',
    preconditions: '',
    steps: [{ action: 'Submit', expected: 'Rejected' }],
    type: 'manual',
    priority: 'normal',
    tags: [],
    requirementIds: [],
    archived: false,
  });
  beforeAll(async () => {
    // Never seed a production URL inherited by a developer or CI runner.
    const url = new URL(process.env.SITES_DATABASE_URL || 'http://invalid');
    if (url.hostname !== 'localhost' || url.pathname !== '/sites')
      throw new Error(
        'QA database acceptance requires isolated localhost/sites CI database',
      );
    prisma = new PrismaService();
    const db = new SitesDb(prisma);
    service = new QaCatalogService(db);
    const raw = db.system('QA isolated acceptance fixture');
    accountA = (
      await raw.siteAccount.create({ data: { verifyToken: randomUUID() } })
    ).id;
    accountB = (
      await raw.siteAccount.create({ data: { verifyToken: randomUUID() } })
    ).id;
    siteA = (
      await db
        .forAccount(accountA)
        .site.create({ data: { accountId: accountA, name: 'QA A' } })
    ).id;
    siteB = (
      await db
        .forAccount(accountB)
        .site.create({ data: { accountId: accountB, name: 'QA B' } })
    ).id;
    caseId = (
      await service.create(member(accountA), siteA, {
        caseKey: 'QA-LOGIN',
        payload: payload(),
      })
    ).id;
  }, 30000);
  afterAll(async () => {
    if (prisma) {
      await prisma.siteAccount.deleteMany({
        where: { id: { in: [accountA, accountB].filter(Boolean) } },
      });
      await prisma.$disconnect();
    }
  });
  it('cannot read another account case through an owned site', async () => {
    await expect(
      service.get(member(accountB), siteB, caseId),
    ).rejects.toMatchObject({ status: 404 });
  });
  it('compound foreign key rejects cross-account revision even bypassing the service', async () => {
    await expect(
      prisma.qaTestCaseRevision.create({
        data: {
          accountId: accountB,
          caseId,
          version: 99,
          payload: payload(),
          createdByMemberId: 'qa-fixture',
        },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
  });
  it('concurrent edits commit exactly one revision and preserve the old snapshot', async () => {
    const results = await Promise.allSettled(
      ['A', 'B'].map((title) =>
        service.replace(member(accountA), siteA, caseId, {
          expectedVersion: 1,
          payload: payload(title),
        }),
      ),
    );
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const failure = results.find(
      (result) => result.status === 'rejected',
    ) as PromiseRejectedResult;
    expect(failure.reason).toMatchObject({ status: 409 });
    const history = await service.history(member(accountA), siteA, caseId);
    expect(history.items.map((item) => item.version)).toEqual([2, 1]);
    expect(history.items[1].payload).toMatchObject({ title: 'Login' });
  }, 30000);
});
