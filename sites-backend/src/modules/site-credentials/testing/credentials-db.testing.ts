/**
 * Стенд хранилища учётных данных на НАСТОЯЩЕМ Postgres (Э-С Ш2): клиент
 * владельца схемы, сервисы ядра и кабинет с сайтом и двумя хостами
 * (подтверждённый и нет). Без `SITES_DIRECT_URL` наборы пропускаются с
 * причиной, при `CI=true` — проваливаются (как остальные наборы на базе).
 */
import { randomBytes, randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { SITES_DB_SCHEMA } from '../../../prisma/prisma.service';
import type { PrismaService } from '../../../prisma/prisma.service';
import { SitesDb } from '../../../prisma/sites-db.service';
import { AccountService } from '../../site-core/account/account.service';
import { HostAccessService } from '../../site-core/ownership/host-access.service';
import { CredentialAuditService } from '../credential-audit.service';
import { SiteCredentialsService } from '../site-credentials.service';

export const RAW_DB_URL = process.env.SITES_DIRECT_URL;
const IN_CI = process.env.CI === 'true';

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

export function pgUrl(url: string): string {
  const u = new URL(url);
  u.searchParams.delete('schema');
  return u.toString();
}

export function ownerPrisma(): PrismaService {
  return new PrismaClient({
    adapter: new PrismaPg(pgUrl(RAW_DB_URL!), { schema: SITES_DB_SCHEMA }),
  }) as unknown as PrismaService;
}

export const testKey = () => randomBytes(32).toString('base64');

export interface CredStack {
  prisma: PrismaService;
  db: SitesDb;
  audit: CredentialAuditService;
  svc: SiteCredentialsService;
}

export function credStack(
  prisma: PrismaService,
  env: NodeJS.ProcessEnv,
): CredStack {
  const db = new SitesDb(prisma);
  const audit = new CredentialAuditService(db);
  const svc = new SiteCredentialsService(
    db,
    new AccountService(db),
    new HostAccessService(db),
    audit,
  );
  svc.env = env;
  return { prisma, db, audit, svc };
}

export interface CabinetFixture {
  accountId: string;
  siteId: string;
  telegramId: bigint;
  /** Подтверждён, срок — сутки вперёд. */
  verifiedHostId: string;
  /** pending. */
  pendingHostId: string;
  domain: string;
}

/** Кабинет (владелец — `telegramId`), сайт и два хоста. */
export async function seedCabinet(
  prisma: PrismaService,
  opts: { role?: 'owner' | 'manager' | 'operator' } = {},
): Promise<CabinetFixture> {
  const telegramId = BigInt(
    8_000_000_000 + Math.floor(Math.random() * 900_000_000),
  );
  const domain = `sh2-${randomUUID().slice(0, 8)}.example.com`;
  const account = await prisma.siteAccount.create({
    data: { verifyToken: `vt-${randomUUID()}` },
  });
  await prisma.siteAccountMember.create({
    data: {
      accountId: account.id,
      telegramId,
      role: opts.role ?? 'owner',
      productRoles: {},
    },
  });
  const site = await prisma.site.create({
    data: { accountId: account.id, name: domain },
  });
  const now = Date.now();
  const verified = await prisma.siteHost.create({
    data: {
      accountId: account.id,
      siteId: site.id,
      host: `shop.${domain}`,
      status: 'verified',
      method: 'dns',
      verifiedAt: new Date(now - 60_000),
      expiresAt: new Date(now + 86_400_000),
    },
  });
  const pending = await prisma.siteHost.create({
    data: { accountId: account.id, siteId: site.id, host: `admin.${domain}` },
  });
  return {
    accountId: account.id,
    siteId: site.id,
    telegramId,
    verifiedHostId: verified.id,
    pendingHostId: pending.id,
    domain,
  };
}

export async function dropCabinet(
  prisma: PrismaService,
  f: CabinetFixture,
): Promise<void> {
  await prisma.siteAccount.deleteMany({ where: { id: f.accountId } });
}
