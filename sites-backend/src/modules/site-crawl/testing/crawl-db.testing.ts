/**
 * Реальный Postgres для тестов обхода (образец — prisma/assist-public-role.spec.ts):
 * строка `SITES_DIRECT_URL`; без неё — `describeDb` пропускает набор с
 * причиной в названии, а при `CI=true` — проваливает (приёмка не должна
 * тихо перестать выполняться).
 *
 * Каждый набор создаёт СВОИ кабинеты со случайными id и удаляет их в конце
 * (каскад FK уносит сайты, хосты, страницы, прогоны, очередь) — параллельные
 * наборы и чужие агенты на той же базе не мешают.
 */

import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { SITES_DB_SCHEMA } from '../../../prisma/prisma.service';
import type { PrismaService } from '../../../prisma/prisma.service';
import { SitesDb } from '../../../prisma/sites-db.service';

export const RAW_DB_URL = process.env.SITES_DIRECT_URL;
const IN_CI = process.env.CI === 'true';

/** `?schema=sites` нужен CLI Prisma; драйверу pg он ни к чему. */
export function pgUrl(url: string): string {
  const u = new URL(url);
  u.searchParams.delete('schema');
  return u.toString();
}

/** describe на реальной базе, иначе — пропуск (или провал в CI). */
export function describeDb(name: string, body: () => void): void {
  if (!RAW_DB_URL) {
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

export function testPrisma(): PrismaService {
  return new PrismaClient({
    adapter: new PrismaPg(pgUrl(RAW_DB_URL!), { schema: SITES_DB_SCHEMA }),
  }) as unknown as PrismaService;
}

export function testSitesDb(prisma: PrismaService): SitesDb {
  return new SitesDb(prisma);
}

export interface HostSpec {
  host: string;
  status?: 'verified' | 'pending' | 'expired' | 'revoked';
}

export interface Fixture {
  accountId: string;
  siteId: string;
  hosts: Record<string, string>;
}

/** Кабинет + сайт + хосты (verified — на 90 дней). */
export async function createSite(
  prisma: PrismaService,
  hosts: HostSpec[],
): Promise<Fixture> {
  const account = await prisma.siteAccount.create({
    data: { verifyToken: `k1-${randomUUID()}` },
  });
  const site = await prisma.site.create({
    data: { accountId: account.id, name: 'Полигон K1' },
  });
  const ids: Record<string, string> = {};
  const now = Date.now();
  for (const h of hosts) {
    const status = h.status ?? 'verified';
    const row = await prisma.siteHost.create({
      data: {
        accountId: account.id,
        siteId: site.id,
        host: h.host,
        status,
        method: status === 'pending' ? null : 'dns',
        verifiedAt: status === 'pending' ? null : new Date(now - 1000),
        expiresAt:
          status === 'verified'
            ? new Date(now + 90 * 24 * 3600 * 1000)
            : status === 'expired'
              ? new Date(now - 1000)
              : null,
        revokedAt: status === 'revoked' ? new Date(now - 1000) : null,
      },
    });
    ids[h.host] = row.id;
  }
  return { accountId: account.id, siteId: site.id, hosts: ids };
}

export async function dropAccounts(
  prisma: PrismaService,
  accountIds: string[],
): Promise<void> {
  if (accountIds.length === 0) return;
  await prisma.siteAccount.deleteMany({ where: { id: { in: accountIds } } });
}

/** Кэш robots — общий по origin; тестовые origin чистим сами. */
export async function dropRobots(
  prisma: PrismaService,
  origins: string[],
): Promise<void> {
  await prisma.siteCrawlRobots.deleteMany({
    where: { origin: { in: origins } },
  });
}
