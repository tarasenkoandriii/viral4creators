import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { SitesDb } from '../../prisma/sites-db.service';
import { QaCatalogService } from '../qa-catalog/qa-catalog.service';
import { AccountMembership } from '../site-core/account/roles';
import { QaStandsService } from './qa-stands.module';
const ciDescribe = process.env.CI === 'true' ? describe : describe.skip;
ciDescribe('QA stand isolated Postgres acceptance', () => {
  let prisma: PrismaService,
    db: SitesDb,
    service: QaStandsService,
    account: string,
    site: string,
    id: string;
  const member = (accountId: string) =>
    ({
      accountId,
      memberId: 'stand-test',
      role: 'owner',
      productRoles: { qa: 'admin', assist: 'none', assistAdmin: 'none' },
    }) as AccountMembership;
  beforeAll(async () => {
    const url = new URL(process.env.SITES_DATABASE_URL || 'http://invalid');
    if (url.hostname !== 'localhost' || url.pathname !== '/sites')
      throw new Error('Only isolated localhost/sites CI database is allowed');
    prisma = new PrismaService();
    db = new SitesDb(prisma);
    service = new QaStandsService(db, new QaCatalogService(db));
    account = (
      await db
        .system('mock stand CI fixture')
        .siteAccount.create({ data: { verifyToken: randomUUID() } })
    ).id;
    site = (
      await db
        .forAccount(account)
        .site.create({ data: { accountId: account, name: 'Mock test' } })
    ).id;
  });
  afterAll(async () => {
    if (account)
      await db
        .system('mock stand CI cleanup')
        .siteAccount.delete({ where: { id: account } });
    await prisma?.$disconnect();
  });
  it('persists contract and deduplicates creation', async () => {
    const body = {
      title: 'Orders',
      description: 'Список заказов. Поля: Название, Статус',
      requestId: randomUUID(),
    };
    const first = await service.create(member(account), site, body);
    id = first.id;
    expect((await service.create(member(account), site, body)).id).toBe(id);
  });
  it('persists CRUD, blocks demo viewer and resets', async () => {
    const m = member(account);
    expect(
      (
        await service.command(m, site, id, {
          method: 'POST',
          role: 'viewer',
          values: ['a', 'b'],
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await service.command(m, site, id, {
          method: 'POST',
          role: 'editor',
          values: ['a', 'b'],
        })
      ).status,
    ).toBe(201);
    let row = (await service.get(m, site, id)).row;
    expect((row.records as unknown[]).length).toBe(2);
    await service.command(m, site, id, {}, true);
    row = (await service.get(m, site, id)).row;
    expect((row.records as unknown[]).length).toBe(1);
    expect(row.revision).toBe(3);
  });
  it('cannot read another account site or bind cross-tenant FK', async () => {
    await expect(service.get(member('other'), site, id)).rejects.toThrow();
    await expect(
      db.forAccount(account).qaStand.create({
        data: {
          accountId: account,
          siteId: 'missing',
          requestId: randomUUID(),
          contract: {},
          records: [],
        },
      }),
    ).rejects.toThrow();
  });
});
