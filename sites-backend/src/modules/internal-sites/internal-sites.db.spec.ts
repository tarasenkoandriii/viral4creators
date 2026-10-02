/**
 * Внутренний API обучалки на НАСТОЯЩЕМ Postgres (П-С3, П-Т1): журнал id
 * запросов (повтор и гонка повторов решаются первичным ключом), чистка по
 * сроку, регистрация хоста с настоящим advisory-lock кабинета и статус.
 * Без `SITES_DIRECT_URL` — пропуск с причиной, при `CI=true` — провал (как
 * у остальных наборов на реальной базе).
 */
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { SITES_DB_SCHEMA } from '../../prisma/prisma.service';
import type { PrismaService } from '../../prisma/prisma.service';
import { SitesDb } from '../../prisma/sites-db.service';
import { AccountService } from '../site-core/account/account.service';
import { HostAccessService } from '../site-core/ownership/host-access.service';
import type { OwnershipChecker } from '../site-core/ownership/ownership-checker';
import { SitesService } from '../site-core/sites/sites.service';
import { InternalSitesService } from './internal-sites.service';
import { InternalRequestLedger, REQUEST_LEDGER_TTL_MS } from './request-ledger';

const RAW = process.env.SITES_DIRECT_URL;
const IN_CI = process.env.CI === 'true';

function describeDb(name: string, body: () => void): void {
  if (!RAW) {
    describe(name, () => {
      (IN_CI ? it : it.skip)(
        'ПРОПУЩЕНО: нет SITES_DIRECT_URL (песочница без базы) — проверка идёт в CI, джоба sites-backend',
        () => {
          throw new Error(
            `CI=true, но SITES_DIRECT_URL не задана — «${name}» не выполнился`,
          );
        },
      );
    });
    return;
  }
  describe(name, body);
}

function pgUrl(url: string): string {
  const u = new URL(url);
  u.searchParams.delete('schema');
  return u.toString();
}

describeDb('internal-sites на реальной базе', () => {
  let prisma: PrismaService;
  let db: SitesDb;
  const tg = BigInt(9_000_000_000 + Math.floor(Math.random() * 1_000_000));
  const domain = `sh1-${randomUUID().slice(0, 8)}.example.com`;

  beforeAll(() => {
    prisma = new PrismaClient({
      adapter: new PrismaPg(pgUrl(RAW!), { schema: SITES_DB_SCHEMA }),
    }) as unknown as PrismaService;
    db = new SitesDb(prisma);
  });

  afterAll(async () => {
    const members = await prisma.siteAccountMember.findMany({
      where: { telegramId: tg },
      select: { accountId: true },
    });
    await prisma.siteAccount.deleteMany({
      where: { id: { in: members.map((m) => m.accountId) } },
    });
    await prisma.$disconnect();
  });

  it('журнал id: первый раз — да, повтор — нет', async () => {
    const ledger = new InternalRequestLedger(db);
    const id = randomUUID();
    await expect(ledger.claim(id, 'generator-tutorial', '/x')).resolves.toBe(
      true,
    );
    await expect(ledger.claim(id, 'generator-tutorial', '/x')).resolves.toBe(
      false,
    );
  });

  it('гонка десяти одинаковых повторов — проходит ровно один', async () => {
    const ledger = new InternalRequestLedger(db);
    const id = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        ledger.claim(id, 'generator-tutorial', '/x'),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('строки старше суток чистятся при следующем вызове', async () => {
    const ledger = new InternalRequestLedger(db);
    const old = randomUUID();
    const now = new Date();
    await ledger.claim(
      old,
      'generator-tutorial',
      '/x',
      new Date(now.getTime() - REQUEST_LEDGER_TTL_MS - 60_000),
    );
    await ledger.claim(randomUUID(), 'generator-tutorial', '/x', now);
    await expect(
      prisma.siteInternalRequest.findUnique({ where: { requestId: old } }),
    ).resolves.toBeNull();
  });

  it('регистрация: кабинет и хост в базе, повтор не плодит строк; статус — B до подтверждения, A после', async () => {
    const svc = new InternalSitesService(
      db,
      new AccountService(db),
      new HostAccessService(db),
      new SitesService(db, {} as OwnershipChecker),
    );
    const url = `https://shop.${domain}/login`;
    const [a, b] = await Promise.all([
      svc.registerHost(tg, url),
      svc.registerHost(tg, url),
    ]);
    expect(a.hostId).toBe(b.hostId);
    const members = await prisma.siteAccountMember.findMany({
      where: { telegramId: tg },
    });
    expect(members).toHaveLength(1);
    expect(members[0].role).toBe('owner');
    await expect(svc.hostStatus(tg, url)).resolves.toMatchObject({
      mode: 'B',
      status: 'pending',
      reason: 'not_verified',
    });
    const now = Date.now();
    await prisma.siteHost.update({
      where: { id: a.hostId },
      data: {
        status: 'verified',
        method: 'dns',
        verifiedAt: new Date(now - 1000),
        expiresAt: new Date(now + 86_400_000),
      },
    });
    await expect(svc.hostStatus(tg, url)).resolves.toMatchObject({
      mode: 'A',
      hostId: a.hostId,
    });
    // Отзыв — сразу B (льготы 72 ч у обучалки нет).
    await prisma.siteHost.update({
      where: { id: a.hostId },
      data: { status: 'revoked', revokedAt: new Date(now - 1000) },
    });
    await expect(svc.hostStatus(tg, url)).resolves.toMatchObject({
      mode: 'B',
      reason: 'revoked',
    });
  });
});
