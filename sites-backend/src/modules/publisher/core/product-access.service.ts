/**
 * AI Publisher — продукт ↔ сайт/кабинет и права участника (P-A1,
 * проектный документ §3.3, §4.1).
 *
 *  - `productId` в URL разрешается ТОЛЬКО в строку кабинета участника
 *    (`SitesDb.forAccount`): «нет» и «чужой» — одинаково 404
 *    `PUB_NOT_FOUND` (как QA, AT-CORE-08);
 *  - права — на каждом запросе заново: активные гранты `pub_role_grants`
 *    (без `revokedAt`) + `productRoles.publisher` членства, которое
 *    `SiteAccountGuard` тоже читает на каждом запросе — отзыв роли действует
 *    на следующем запросе (AT-CORE-11), кэша нет.
 */
import { Injectable } from '@nestjs/common';
import { SitesDb } from '../../../prisma/sites-db.service';
import {
  parseAccountRole,
  parseProductRoles,
  type AccountMembership,
} from '../../site-core/account/roles';
import type { ProductCtx } from '../contracts/common';
import {
  PUB_ROLES,
  isOneOf,
  type ProductKind,
  type ProductMode,
  type ProductStatus,
  type PubRole,
} from '../contracts/states';
import { PubError } from './errors';
import type { PubTx } from './ports';
import { accessOf, type PubAccess } from './roles';

export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

interface ProductRow {
  id: string;
  accountId: string;
  siteId: string;
  kind: string;
  mode: string;
  status: string;
  revision: number;
}

export function toProductCtx(r: ProductRow): ProductCtx {
  return {
    id: r.id,
    accountId: r.accountId,
    siteId: r.siteId,
    kind: r.kind as ProductKind,
    mode: r.mode as ProductMode,
    status: r.status as ProductStatus,
    revision: r.revision,
  };
}

const SELECT = {
  id: true,
  accountId: true,
  siteId: true,
  kind: true,
  mode: true,
  status: true,
  revision: true,
} as const;

/** `publisher=admin` или владелец кабинета. */
export function isPublisherAdmin(m: AccountMembership): boolean {
  return m.role === 'owner' || m.productRoles.publisher === 'admin';
}

/**
 * Права ДРУГОГО участника кабинета на продукт — из транзакции операции
 * (назначение задачи проверки, аудит P3-14а): null — участника нет или нет
 * допуска к Publisher.
 */
export async function memberAccessIn(
  tx: Pick<PubTx, 'siteAccountMember' | 'pubRoleGrant'>,
  productId: string,
  memberId: string,
): Promise<PubAccess | null> {
  const row = await tx.siteAccountMember.findFirst({
    where: { id: memberId },
    select: { id: true, role: true, productRoles: true },
  });
  if (!row) return null;
  const owner = parseAccountRole(row.role) === 'owner';
  const publisher = parseProductRoles(row.productRoles).publisher ?? 'none';
  if (!owner && publisher === 'none') return null;
  const grants = await tx.pubRoleGrant.findMany({
    where: { productId, memberId, revokedAt: null },
    select: { role: true },
  });
  return accessOf({
    memberId,
    grants: grants
      .map((g) => g.role)
      .filter((r): r is PubRole => isOneOf(PUB_ROLES, r)),
    admin: owner || publisher === 'admin',
    accountOwner: owner,
  });
}

@Injectable()
export class ProductAccessService {
  constructor(private readonly db: SitesDb) {}

  /** Продукт кабинета участника или 404 (одинаково для «нет» и «чужой»). */
  async resolveProduct(
    m: AccountMembership,
    productId: string,
  ): Promise<ProductCtx> {
    if (typeof productId !== 'string' || !ID_RE.test(productId)) {
      throw new PubError('PUB_NOT_FOUND');
    }
    const row = await this.db
      .forAccount(m.accountId)
      .pubProduct.findFirst({ where: { id: productId }, select: SELECT });
    if (!row) throw new PubError('PUB_NOT_FOUND');
    return toProductCtx(row);
  }

  /**
   * Продукт сайта или null. Сайт не в кабинете участника — 404
   * `PUB_NOT_FOUND` (сайт чужого кабинета не отличим от несуществующего).
   */
  async resolveProductBySite(
    m: AccountMembership,
    siteId: string,
  ): Promise<ProductCtx | null> {
    if (typeof siteId !== 'string' || !ID_RE.test(siteId)) {
      throw new PubError('PUB_NOT_FOUND');
    }
    const db = this.db.forAccount(m.accountId);
    const site = await db.site.findFirst({
      where: { id: siteId },
      select: { id: true },
    });
    if (!site) throw new PubError('PUB_NOT_FOUND');
    const row = await db.pubProduct.findFirst({
      where: { siteId },
      select: SELECT,
    });
    return row ? toProductCtx(row) : null;
  }

  /** Активные роли участника в продукте (каждый запрос — из базы). */
  async activeRoles(
    db: Pick<PubTx, 'pubRoleGrant'>,
    productId: string,
    memberId: string,
  ): Promise<PubRole[]> {
    const rows = await db.pubRoleGrant.findMany({
      where: { productId, memberId, revokedAt: null },
      select: { role: true },
    });
    return rows
      .map((r) => r.role)
      .filter((r): r is PubRole => isOneOf(PUB_ROLES, r));
  }

  /** Права участника в продукте (null — продукта ещё нет: только членство). */
  async accessFor(
    m: AccountMembership,
    product: ProductCtx | null,
  ): Promise<PubAccess> {
    const grants = product
      ? await this.activeRoles(
          this.db.forAccount(m.accountId),
          product.id,
          m.memberId,
        )
      : [];
    return accessOf({
      memberId: m.memberId,
      grants,
      admin: isPublisherAdmin(m),
      accountOwner: m.role === 'owner',
    });
  }
}
