/**
 * AI Publisher — фикстуры уровня продукта (P-A1, проектный документ §16.0;
 * план внешнего аудита: TD-01, TD-02). Только три фабрики: кабинеты,
 * продукт, участники с ролями. Предметные построители TD-03…TD-10 — в
 * `<зона>/testing/` пакетов-владельцев.
 *
 *  - `seedTwoAccounts()` — TD-01: два изолированных кабинета с разными
 *    владельцами, у каждого сайт (и, по желанию, продукт `kind=test`);
 *  - `seedProduct({kind})` — продукт напрямую (без шагов пакетов этапа 1):
 *    строка продукта, 38 параметров-допущений, кампания «пилот»;
 *  - `seedMembers()` — TD-02: владелец кабинета, роли продукта (PO, ED,
 *    OP, AN, SA, VW), администратор (`publisher=admin` без грантов),
 *    участник Publisher без ролей и участник без допуска (`none`) — с
 *    ожидаемыми разрешёнными действиями по матрице §4.2.
 *
 * Пишет сырым клиентом владельца схемы (тест), id — случайные: наборы на
 * общей базе не пересекаются; append-only строки не удаляются.
 */
import { Prisma } from '@prisma/client';
import { randomBytes, randomInt } from 'crypto';
import type { PrismaService } from '../../../prisma/prisma.service';
import {
  OWNER_PRODUCT_ROLES,
  parseProductRoles,
  type AccountMembership,
  type AccountRole,
} from '../../site-core/account/roles';
import type { ProductCtx } from '../contracts/common';
import {
  DEFAULT_PARAMETER_VALUES,
  PARAMETER_KEYS,
  type ParameterKey,
} from '../contracts/parameters';
import type { ProductKind, ProductMode, PubRole } from '../contracts/states';
import { addKyivCalendarDays } from '../core/kyiv-time';
import { parameterPlaceholderIssues } from '../core/parameter-schemas';
import {
  PILOT_CAMPAIGN_CODE,
  PILOT_CAMPAIGN_NAME,
  newPublicKey,
} from '../core/product.service';
import { accessOf, allowedActions, type PubAction } from '../core/roles';

export const tid = (p: string): string =>
  `${p}_${randomBytes(6).toString('hex')}`;
/** Безопасный для initData Telegram id (≤ 2^53). */
export const telegramIdOf = (): bigint =>
  BigInt(7_000_000_000 + randomInt(0, 2_000_000_000));

export interface SeededAccount {
  accountId: string;
  siteId: string;
  owner: SeededMember;
}

export interface SeededMember {
  memberId: string;
  telegramId: bigint;
  membership: AccountMembership;
}

async function member(
  db: PrismaService,
  accountId: string,
  role: AccountRole,
  productRoles: Record<string, string>,
): Promise<SeededMember> {
  const telegramId = telegramIdOf();
  const row = await db.siteAccountMember.create({
    data: { accountId, telegramId, role, productRoles },
  });
  return {
    memberId: row.id,
    telegramId,
    membership: {
      accountId,
      memberId: row.id,
      telegramId,
      role,
      productRoles: parseProductRoles(productRoles),
    },
  };
}

export async function seedAccount(db: PrismaService): Promise<SeededAccount> {
  const account = await db.siteAccount.create({
    data: { verifyToken: randomBytes(24).toString('base64url') },
  });
  const owner = await member(db, account.id, 'owner', {
    ...OWNER_PRODUCT_ROLES,
  });
  const site = await db.site.create({
    data: { accountId: account.id, name: tid('site') },
  });
  return { accountId: account.id, siteId: site.id, owner };
}

/** Ещё один сайт кабинета (тестовый/eval-продукт — на отдельном сайте). */
export async function seedSite(
  db: PrismaService,
  accountId: string,
): Promise<string> {
  const site = await db.site.create({ data: { accountId, name: tid('site') } });
  return site.id;
}

/** Подтверждённый хост сайта (для гейта `public_publish`). */
export async function seedVerifiedHost(
  db: PrismaService,
  accountId: string,
  siteId: string,
  host: string,
  now = new Date(),
): Promise<string> {
  const row = await db.siteHost.create({
    data: {
      accountId,
      siteId,
      host,
      status: 'verified',
      method: 'dns',
      verifiedAt: now,
      expiresAt: addKyivCalendarDays(now, 30),
    },
  });
  return row.id;
}

export interface SeedProductInput {
  accountId: string;
  siteId?: string;
  kind?: ProductKind;
  mode?: ProductMode;
  name?: string;
  actor?: string;
}

export interface SeededProduct extends ProductCtx {
  publicKey: string;
}

/** Продукт напрямую: строка, 38 допущений, кампания «пилот». */
export async function seedProduct(
  db: PrismaService,
  input: SeedProductInput,
): Promise<SeededProduct> {
  const siteId = input.siteId ?? (await seedSite(db, input.accountId));
  const actor = input.actor ?? 'system:test-seed';
  const kind = input.kind ?? 'test';
  const row = await db.pubProduct.create({
    data: {
      accountId: input.accountId,
      siteId,
      kind,
      name: input.name ?? `Продукт ${tid('p')}`,
      publicKey: newPublicKey(),
      mode: input.mode ?? 'closed',
      liveSince: input.mode === 'live' ? new Date() : null,
      status: 'active',
      createdBy: actor,
    },
  });
  await db.pubParameter.createMany({
    data: PARAMETER_KEYS.map((key) => ({
      accountId: input.accountId,
      productId: row.id,
      key,
      value: DEFAULT_PARAMETER_VALUES[key] as Prisma.InputJsonValue,
      status: 'assumption',
      version: 1,
      createdBy: actor,
    })),
  });
  await db.pubCampaign.create({
    data: {
      accountId: input.accountId,
      productId: row.id,
      code: PILOT_CAMPAIGN_CODE,
      name: PILOT_CAMPAIGN_NAME,
      createdBy: actor,
    },
  });
  return {
    id: row.id,
    accountId: row.accountId,
    siteId: row.siteId,
    kind: row.kind as ProductKind,
    mode: row.mode as ProductMode,
    status: 'active',
    revision: row.revision,
    publicKey: row.publicKey,
  };
}

export interface TwoAccounts {
  a: SeededAccount & { product?: SeededProduct };
  b: SeededAccount & { product?: SeededProduct };
}

/** TD-01: два изолированных кабинета с разными владельцами. */
export async function seedTwoAccounts(
  db: PrismaService,
  opts: { withProducts?: boolean; kind?: ProductKind } = {},
): Promise<TwoAccounts> {
  const a: TwoAccounts['a'] = await seedAccount(db);
  const b: TwoAccounts['b'] = await seedAccount(db);
  if (opts.withProducts) {
    a.product = await seedProduct(db, {
      accountId: a.accountId,
      siteId: a.siteId,
      kind: opts.kind,
    });
    b.product = await seedProduct(db, {
      accountId: b.accountId,
      siteId: b.siteId,
      kind: opts.kind,
    });
  }
  return { a, b };
}

/** Ключи TD-02. */
export const TD02_KEYS = [
  'accountOwner',
  'product_owner',
  'editor',
  'operator',
  'analyst',
  'sales',
  'viewer',
  'admin',
  'memberNoRoles',
  'noAccess',
] as const;
export type Td02Key = (typeof TD02_KEYS)[number];

/** Ожидаемые разрешённые действия ключа TD-02 (матрица §4.2). */
export function td02Allowed(key: Td02Key, memberId = 'x'): PubAction[] {
  if (key === 'noAccess') return [];
  const grants: PubRole[] = (
    [
      'product_owner',
      'editor',
      'operator',
      'analyst',
      'sales',
      'viewer',
    ] as const
  ).includes(key as PubRole)
    ? [key as PubRole]
    : [];
  return allowedActions(
    accessOf({
      memberId,
      grants,
      admin: key === 'admin',
      accountOwner: key === 'accountOwner',
    }),
  );
}

export type SeededMembers = Record<Td02Key, SeededMember>;

/**
 * TD-02: участники кабинета продукта. Роли продукта — гранты (выдал
 * владелец кабинета); `admin` — `productRoles.publisher='admin'` без
 * грантов; `noAccess` — `publisher` нет (`none`).
 */
export async function seedMembers(
  db: PrismaService,
  product: Pick<ProductCtx, 'id' | 'accountId'>,
  owner: SeededMember,
): Promise<SeededMembers> {
  const out = { accountOwner: owner } as SeededMembers;
  for (const key of TD02_KEYS) {
    if (key === 'accountOwner') continue;
    const publisher =
      key === 'noAccess' ? null : key === 'admin' ? 'admin' : 'member';
    const productRoles: Record<string, string> = {
      qa: 'none',
      assist: 'none',
      assistAdmin: 'none',
    };
    if (publisher) productRoles.publisher = publisher;
    const m = await member(db, product.accountId, 'operator', productRoles);
    out[key] = m;
    if (
      (
        [
          'product_owner',
          'editor',
          'operator',
          'analyst',
          'sales',
          'viewer',
        ] as string[]
      ).includes(key)
    ) {
      await grantRole(
        db,
        product,
        m.memberId,
        key as PubRole,
        `member:${owner.memberId}`,
      );
    }
  }
  return out;
}

/** Грант напрямую (фикстура; в продукте — `POST …/roles`). */
export async function grantRole(
  db: PrismaService,
  product: Pick<ProductCtx, 'id' | 'accountId'>,
  memberId: string,
  role: PubRole,
  actor = 'system:test-seed',
): Promise<string> {
  const row = await db.pubRoleGrant.create({
    data: {
      accountId: product.accountId,
      productId: product.id,
      memberId,
      memberDisplayName: `Учасник …${memberId.slice(-6)}`,
      role,
      grantedBy: actor,
      createdBy: actor,
    },
  });
  return row.id;
}

/**
 * Slug для тестов: префикс + 8 случайных БУКВ. Цифры недопустимы — slug с
 * 7+ цифрами (вместе с цифрами префикса) «похож на телефон» и отвергается
 * (400 `slug: contact_like`, Р-PUB-Z2-16).
 */
export function testSlug(prefix: string): string {
  const letters = randomBytes(8)
    .toString('hex')
    .replace(/[0-9]/g, (d) => 'ghijklmnop'[Number(d)])
    .slice(0, 8);
  return `${prefix}-${letters}`;
}

/**
 * Утверждаемое тестом значение ключа (Р-PUB-Z2-26): заглушку умолчания
 * (уведомление о данных «Чернетка…») утвердить нельзя, и как утверждённая
 * она гейт не открывает — фикстуры, утверждающие «текущее значение»,
 * подставляют реальный текст уведомления.
 */
export const TEST_DATA_NOTICE = {
  version: 'notice-test-1',
  text: 'Ми обробляємо ім’я та контакт із заявки лише для відповіді на неї.',
} as const;

export function approvableValue(key: string, current: unknown): unknown {
  return parameterPlaceholderIssues(key as ParameterKey, current).length
    ? { ...TEST_DATA_NOTICE }
    : current;
}
