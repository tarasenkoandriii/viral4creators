/**
 * AI Publisher — роли в продукте `pub_role_grants` (P-A1, проектный
 * документ §4.1; AT-CORE-11). Выдаёт и отзывает только `publisher=admin`
 * (маршрут — `role.manage`). Активна строка без `revokedAt`; две активные
 * одинаковые роли участнику запрещает частичный уникальный индекс; отзыв —
 * однократное заполнение `revoked*` (триггер), снятый грант не оживает.
 *
 * Участник — только этого кабинета и с допуском к Publisher
 * (`productRoles.publisher ∈ admin|member` или владелец): грант без допуска
 * не дал бы ничего (`SiteAccountGuard` закроет маршрут раньше). Выдача себе
 * — `selfReview=true` в журнале (§4.1).
 *
 * Ссылки на участников — без FK, со снимком имени (аудит P2-26).
 */
import { Injectable } from '@nestjs/common';
import {
  parseAccountRole,
  parseProductRoles,
} from '../../site-core/account/roles';
import type { RoleGrantView } from '../contracts/core-api';
import { PUB_ROLES, isOneOf, type PubRole } from '../contracts/states';
import { AuditService } from './audit';
import { PubError, assertNoIssues, validationError } from './errors';
import { piiIssues } from './pii-guard';
import type { ProductRef, PubTx } from './ports';
import { ID_RE } from './product-access.service';

type GrantRow = {
  id: string;
  memberId: string;
  memberDisplayName: string;
  role: string;
  grantedBy: string;
  grantedAt: Date;
  revokedBy: string | null;
  revokedAt: Date | null;
  reason: string | null;
};

export function grantView(r: GrantRow): RoleGrantView {
  return {
    id: r.id,
    memberId: r.memberId,
    memberDisplayName: r.memberDisplayName,
    role: r.role as PubRole,
    grantedBy: r.grantedBy,
    grantedAt: r.grantedAt.toISOString(),
    revokedBy: r.revokedBy,
    revokedAt: r.revokedAt?.toISOString() ?? null,
    reason: r.reason,
    active: r.revokedAt === null,
  };
}

/** Снимок отображаемого имени без контактов: заданное или «Учасник …xxxxxx». */
export function displayNameOf(memberId: string, given: unknown): string {
  if (typeof given === 'string' && given.trim()) {
    const v = given.trim();
    if ([...v].length > 200)
      throw validationError([{ field: 'displayName', code: 'length' }]);
    assertNoIssues(piiIssues({ displayName: v }));
    return v;
  }
  return `Учасник …${memberId.slice(-6)}`;
}

@Injectable()
export class RoleGrantsService {
  constructor(private readonly audit: AuditService) {}

  /** Один грант продукта (пересборка ответа выдачи, `storeResponse:false`). */
  async view(db: PubTx, productId: string, id: string): Promise<RoleGrantView> {
    const row = await db.pubRoleGrant.findFirst({ where: { id, productId } });
    if (!row) throw new PubError('PUB_NOT_FOUND');
    return grantView(row);
  }

  async list(db: PubTx, productId: string): Promise<RoleGrantView[]> {
    const rows = await db.pubRoleGrant.findMany({
      where: { productId },
      orderBy: [{ grantedAt: 'desc' }, { id: 'desc' }],
    });
    return rows.map(grantView);
  }

  async grant(
    tx: PubTx,
    product: ProductRef,
    input: { memberId: unknown; role: unknown; displayName?: unknown },
    actor: { id: string; memberId: string },
  ): Promise<RoleGrantView> {
    if (typeof input.memberId !== 'string' || !ID_RE.test(input.memberId)) {
      throw validationError([{ field: 'memberId', code: 'format' }]);
    }
    if (!isOneOf(PUB_ROLES, input.role)) {
      throw validationError([{ field: 'role', code: 'enum' }]);
    }
    const memberId = input.memberId;
    const role = input.role;
    const member = await tx.siteAccountMember.findFirst({
      where: { id: memberId },
      select: { id: true, role: true, productRoles: true },
    });
    if (!member) throw new PubError('PUB_NOT_FOUND', { reason: 'member' });
    const owner = parseAccountRole(member.role) === 'owner';
    const access = parseProductRoles(member.productRoles).publisher ?? 'none';
    if (!owner && access === 'none') {
      throw validationError([
        { field: 'memberId', code: 'no_publisher_access' },
      ]);
    }
    const dup = await tx.pubRoleGrant.findFirst({
      where: { productId: product.id, memberId, role, revokedAt: null },
      select: { id: true },
    });
    if (dup)
      throw new PubError('PUB_CONFLICT', {
        reason: 'already_granted',
        grantId: dup.id,
      });
    const row = await tx.pubRoleGrant.create({
      data: {
        accountId: product.accountId,
        productId: product.id,
        memberId,
        memberDisplayName: displayNameOf(memberId, input.displayName),
        role,
        grantedBy: actor.id,
        createdBy: actor.id,
      },
    });
    await this.audit.write(tx, {
      accountId: product.accountId,
      productId: product.id,
      actor: actor.id,
      objectType: 'role_grant',
      objectId: row.id,
      action: 'grant',
      toStatus: 'active',
      meta: { memberId, role, selfReview: memberId === actor.memberId },
    });
    return grantView(row);
  }

  async revoke(
    tx: PubTx,
    product: ProductRef,
    grantId: string,
    reason: unknown,
    actor: string,
    now = new Date(),
  ): Promise<RoleGrantView> {
    if (
      typeof reason !== 'string' ||
      !reason.trim() ||
      [...reason].length > 2000
    ) {
      throw validationError([
        { field: 'reason', code: reason === undefined ? 'required' : 'length' },
      ]);
    }
    assertNoIssues(piiIssues({ reason }));
    const g = await tx.pubRoleGrant.findFirst({
      where: { id: grantId, productId: product.id },
    });
    if (!g) throw new PubError('PUB_NOT_FOUND');
    if (g.revokedAt) {
      throw new PubError('PUB_TRANSITION_INVALID', {
        machine: 'role_grant',
        from: 'revoked',
        to: 'revoked',
        allowed: [],
      });
    }
    const n = await tx.pubRoleGrant.updateMany({
      where: { id: g.id, revokedAt: null },
      data: { revokedAt: now, revokedBy: actor, reason },
    });
    if (n.count !== 1)
      throw new PubError('PUB_CONFLICT', { reason: 'already_revoked' });
    await this.audit.write(tx, {
      accountId: product.accountId,
      productId: product.id,
      actor,
      objectType: 'role_grant',
      objectId: g.id,
      action: 'revoke',
      fromStatus: 'active',
      toStatus: 'revoked',
      reason,
      meta: { memberId: g.memberId, role: g.role },
    });
    return grantView({ ...g, revokedAt: now, revokedBy: actor, reason });
  }
}
