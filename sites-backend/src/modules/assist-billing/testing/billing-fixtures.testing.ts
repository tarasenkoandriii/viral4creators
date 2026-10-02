/**
 * Помощники тестов Э4: тариф кабинета и счётчик единиц на реальной базе
 * (клиент — владелец схемы). Только свои кабинеты — строки по accountId.
 */
import { randomUUID } from 'crypto';
import type { PrismaService } from '../../../prisma/prisma.service';
import type { AssistPlanId } from '../plans';
import { readState, type RawDb } from '../public/entitlements';
import type { SubscriptionState } from '../subscription-state';

const DAY = 24 * 60 * 60 * 1000;

/** Подписка кабинета: тариф, способ, оплачено на `days` дней от `from`. */
export async function setPlan(
  db: RawDb,
  accountId: string,
  planId: AssistPlanId,
  opts: {
    method?: string;
    from?: Date;
    days?: number;
    status?: string;
    autoTopUp?: boolean;
    autoTopUpCapMicroUsd?: number;
    recTokenEnc?: string | null;
    cancelAtPeriodEnd?: boolean;
  } = {},
): Promise<void> {
  const from = opts.from ?? new Date(Date.now() - 60_000);
  const days = opts.days ?? (planId === 'trial' ? 14 : 30);
  await db.$executeRawUnsafe(
    `INSERT INTO "sites"."assist_subscriptions"
       ("accountId", "planId", "status", "method", "anchorAt", "paidThrough",
        "cancelAtPeriodEnd", "autoTopUp", "autoTopUpCapMicroUsd", "recTokenEnc", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
     ON CONFLICT ("accountId") DO UPDATE SET
       "planId" = EXCLUDED."planId", "status" = EXCLUDED."status",
       "method" = EXCLUDED."method", "anchorAt" = EXCLUDED."anchorAt",
       "paidThrough" = EXCLUDED."paidThrough",
       "cancelAtPeriodEnd" = EXCLUDED."cancelAtPeriodEnd",
       "autoTopUp" = EXCLUDED."autoTopUp",
       "autoTopUpCapMicroUsd" = EXCLUDED."autoTopUpCapMicroUsd",
       "recTokenEnc" = EXCLUDED."recTokenEnc", "updatedAt" = now()`,
    accountId,
    planId,
    opts.status ?? 'active',
    opts.method ?? (planId === 'trial' ? 'trial' : 'manual'),
    from,
    new Date(from.getTime() + days * DAY),
    opts.cancelAtPeriodEnd ?? false,
    opts.autoTopUp ?? false,
    BigInt(opts.autoTopUpCapMicroUsd ?? 0),
    opts.recTokenEnc ?? null,
  );
}

/** Выставить счётчик текущего периода (units/extraUnits). */
export async function seedUsage(
  db: RawDb,
  accountId: string,
  p: { units: number; dialogs?: number; extraUnits?: number },
  now: Date = new Date(),
): Promise<SubscriptionState> {
  const state = await readState(db, accountId, now);
  if (!state.periodKey) throw new Error('seedUsage: у кабинета нет периода');
  await db.$executeRawUnsafe(
    `INSERT INTO "sites"."assist_account_usage" ("accountId", "periodKey", "units", "dialogs", "extraUnits", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT ("accountId", "periodKey") DO UPDATE SET
       "units" = EXCLUDED."units", "dialogs" = EXCLUDED."dialogs", "extraUnits" = EXCLUDED."extraUnits"`,
    accountId,
    state.periodKey,
    p.units,
    p.dialogs ?? p.units,
    p.extraUnits ?? 0,
  );
  return state;
}

export async function usageOf(
  db: RawDb,
  accountId: string,
  now: Date = new Date(),
): Promise<{ units: number; dialogs: number; extraUnits: number } | null> {
  const state = await readState(db, accountId, now);
  if (!state.periodKey) return null;
  const rows = await db.$queryRawUnsafe<
    Array<{ units: number; dialogs: number; extraUnits: number }>
  >(
    `SELECT "units", "dialogs", "extraUnits" FROM "sites"."assist_account_usage"
      WHERE "accountId" = $1 AND "periodKey" = $2`,
    accountId,
    state.periodKey,
  );
  return rows[0] ?? null;
}

let tg = 7_400_000_000 + Math.floor(Math.random() * 1_000_000) * 100;

export interface BillingAccount {
  accountId: string;
  siteId: string;
  ownerTelegramId: bigint;
  managerTelegramId: bigint;
}

/**
 * Свой кабинет: владелец, менеджер помощника, сайт с хостом и строкой
 * assist_sites (начало пробного — сейчас). Другие строки тесты не трогают.
 */
export async function createAccount(
  owner: PrismaService,
  opts: { createdAt?: Date } = {},
): Promise<BillingAccount> {
  const account = await owner.siteAccount.create({
    data: { verifyToken: `e4-${randomUUID()}` },
  });
  const ownerTelegramId = BigInt(++tg);
  const managerTelegramId = BigInt(++tg);
  await owner.siteAccountMember.create({
    data: {
      accountId: account.id,
      telegramId: ownerTelegramId,
      role: 'owner',
      productRoles: { qa: 'admin', assist: 'manager', assistAdmin: 'owner' },
    },
  });
  await owner.siteAccountMember.create({
    data: {
      accountId: account.id,
      telegramId: managerTelegramId,
      role: 'manager',
      productRoles: { qa: 'none', assist: 'manager', assistAdmin: 'none' },
    },
  });
  const site = await owner.site.create({
    data: { accountId: account.id, name: 'Сайт Э4' },
  });
  await owner.siteHost.create({
    data: {
      accountId: account.id,
      siteId: site.id,
      host: `e4-${randomUUID().slice(0, 8)}.example.com`,
      status: 'verified',
      method: 'dns',
      verifiedAt: new Date(),
    },
  });
  await owner.assistSite.create({
    data: {
      accountId: account.id,
      siteId: site.id,
      enabled: true,
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    },
  });
  return {
    accountId: account.id,
    siteId: site.id,
    ownerTelegramId,
    managerTelegramId,
  };
}
