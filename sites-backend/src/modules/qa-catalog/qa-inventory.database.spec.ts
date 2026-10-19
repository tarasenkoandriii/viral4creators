import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { SitesDb } from '../../prisma/sites-db.service';
import { AccountMembership } from '../site-core/account/roles';
import { QaCatalogService } from './qa-catalog.service';
import { QaInventoryService } from './qa-inventory.service';
const ciDescribe = process.env.CI === 'true' ? describe : describe.skip;
ciDescribe('QA inventory: atomic import, replay and scoped search', () => {
  let prisma: PrismaService,
    catalog: QaCatalogService,
    inventory: QaInventoryService,
    account: string,
    site: string;
  const member = (qa = 'admin') =>
    ({
      accountId: account,
      memberId: 'inventory-test',
      role: 'operator',
      productRoles: { qa, assist: 'none', assistAdmin: 'none' },
    }) as AccountMembership;
  const row = (key: string) => ({
    caseKey: key,
    payload: {
      title: 'Login ' + key,
      purpose: '',
      preconditions: '',
      steps: [{ action: 'Open', expected: 'Visible' }],
      type: 'manual',
      priority: 'normal',
      tags: ['onboarding'],
      requirementIds: ['REQ-LOGIN'],
      archived: false,
    },
  });
  beforeAll(async () => {
    const url = new URL(process.env.SITES_DATABASE_URL ?? 'http://invalid');
    if (url.hostname !== 'localhost' || url.pathname !== '/sites')
      throw new Error('isolated localhost/sites only');
    prisma = new PrismaService();
    catalog = new QaCatalogService(new SitesDb(prisma));
    inventory = new QaInventoryService(catalog);
    account = (
      await prisma.siteAccount.create({ data: { verifyToken: randomUUID() } })
    ).id;
    site = (
      await prisma.site.create({
        data: { accountId: account, name: 'Inventory' },
      })
    ).id;
  }, 30000);
  afterAll(async () => {
    if (prisma) {
      await prisma.siteAccount.deleteMany({ where: { id: account } });
      await prisma.$disconnect();
    }
  });
  it('atomically imports, replays and preserves later revisions', async () => {
    const cases = [row('QA-CSV-A'), row('QA-CSV-B')];
    expect(await inventory.import(member(), site, { cases })).toEqual({
      created: 2,
      replayed: false,
    });
    const c = await prisma.qaTestCase.findFirstOrThrow({
      where: { siteId: site, caseKey: 'QA-CSV-A' },
    });
    await catalog.replace(member(), site, c.id, {
      expectedVersion: 1,
      payload: { ...cases[0].payload, title: 'Changed after import' },
    });
    expect(await inventory.import(member(), site, { cases })).toEqual({
      created: 0,
      replayed: true,
    });
    expect((await catalog.get(member(), site, c.id)).title).toBe(
      'Changed after import',
    );
    expect(
      (await inventory.get(member('viewer'), site, 'changed')).items,
    ).toHaveLength(1);
  });
  it('a conflicting batch rolls back every new case', async () => {
    await expect(
      inventory.import(member(), site, {
        cases: [
          row('QA-CSV-C'),
          {
            ...row('QA-CSV-A'),
            payload: { ...row('QA-CSV-A').payload, title: 'Conflicting' },
          },
        ],
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      await prisma.qaTestCase.count({
        where: { siteId: site, caseKey: 'QA-CSV-C' },
      }),
    ).toBe(0);
  });
  it('rejects duplicate keys, unknown envelope and viewer writes', async () => {
    await expect(
      inventory.import(member(), site, {
        cases: [row('QA-DUP'), row('QA-DUP')],
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      inventory.import(member(), site, {
        cases: [row('QA-DUP')],
        accountId: 'other',
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      inventory.import(member('viewer'), site, { cases: [row('QA-VIEWER')] }),
    ).rejects.toMatchObject({ status: 403 });
  });
});
