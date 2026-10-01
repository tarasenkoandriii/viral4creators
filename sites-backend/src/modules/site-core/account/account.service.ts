/**
 * Кабинет (`SiteAccount`) и его участники — ядро site-core (ТЗ помощника
 * §3.0, §3.2; QA-ТЗ §1.5, §2.1).
 *
 * Человек узнаётся по `telegramId` — он один у человека в обоих ботах,
 * поэтому вход через помощника и через QA приводит в ОДИН кабинет с теми
 * же сайтами и подтверждениями. Кабинет создаётся при первом входе.
 */

import { BadRequestException, Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { SitesDb } from '../../../prisma/sites-db.service';
import type { RequestIdentity } from '../../telegram-auth/identity';
import {
  INVITE_TTL_MS,
  forbidden,
  siteCoreError,
} from '../site-core.constants';
import {
  AccountMembership,
  AccountRole,
  OWNER_PRODUCT_ROLES,
  ProductRoles,
  parseAccountRole,
  parseProductRoles,
  validateProductRolesInput,
} from './roles';

/** Токен кабинета: 32 символа `[A-Za-z0-9_-]` (как ждёт site-tma-kit). */
export function newVerifyToken(): string {
  return randomBytes(24).toString('base64url');
}

export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Префикс `startapp` приглашения (реестр префиксов — site-tma-kit). */
export const INVITE_START_PREFIX = 'inv_';

export interface MemberView {
  telegramId: string;
  role: AccountRole;
  productRoles: ProductRoles;
}

export interface AccountInfo {
  account: {
    id: string;
    type: 'owner' | 'agency';
    region: string;
    /** Только владельцу и менеджеру — им подтверждать владение. */
    verifyToken: string | null;
  };
  me: MemberView;
  /** Только владельцу и менеджеру; оператор видит себя. */
  members?: MemberView[];
  /** Все кабинеты человека — для переключения (заголовок X-Site-Account). */
  accounts: Array<{ id: string; role: AccountRole }>;
  created: boolean;
}

interface MemberRow {
  id: string;
  accountId: string;
  telegramId: bigint;
  role: string;
  productRoles: unknown;
  createdAt: Date;
}

function toMembership(row: MemberRow): AccountMembership | null {
  const role = parseAccountRole(row.role);
  if (!role) return null;
  return {
    accountId: row.accountId,
    memberId: row.id,
    telegramId: row.telegramId,
    role,
    productRoles:
      role === 'owner'
        ? { ...OWNER_PRODUCT_ROLES }
        : parseProductRoles(row.productRoles),
  };
}

function memberView(m: AccountMembership): MemberView {
  return {
    telegramId: m.telegramId.toString(),
    role: m.role,
    productRoles: m.productRoles,
  };
}

const canManage = (role: AccountRole) => role === 'owner' || role === 'manager';

@Injectable()
export class AccountService {
  constructor(private readonly db: SitesDb) {}

  /** Все членства человека — новые первыми. Вход — вне одного кабинета. */
  async memberships(telegramId: bigint): Promise<AccountMembership[]> {
    const rows = (await this.db
      .system('вход: в каких кабинетах этот telegramId')
      .siteAccountMember.findMany({
        where: { telegramId },
        orderBy: { createdAt: 'desc' },
      })) as MemberRow[];
    return rows
      .map(toMembership)
      .filter((m): m is AccountMembership => m !== null);
  }

  /**
   * Членство для запроса. Явно запрошенный кабинет (заголовок) — только
   * если человек в нём состоит; иначе — последний, куда его добавили
   * (принятое приглашение важнее автосозданного пустого кабинета).
   */
  async resolveMembership(
    telegramId: bigint,
    requestedAccountId?: string,
  ): Promise<AccountMembership | null> {
    const all = await this.memberships(telegramId);
    if (requestedAccountId) {
      return all.find((m) => m.accountId === requestedAccountId) ?? null;
    }
    return all[0] ?? null;
  }

  /**
   * Кабинет при входе: найти или создать. Создание — под advisory-lock по
   * telegramId: два первых запроса TMA параллельно (а она шлёт их пачкой)
   * иначе создали бы человеку два кабинета.
   */
  async ensureAccount(
    identity: RequestIdentity,
    requestedAccountId?: string,
  ): Promise<{ membership: AccountMembership; created: boolean }> {
    const found = await this.resolveMembership(
      identity.telegramId,
      requestedAccountId,
    );
    if (found) return { membership: found, created: false };
    if (requestedAccountId) {
      throw forbidden('ACCOUNT_REQUIRED', 'Вы не состоите в этом кабинете');
    }
    const system = this.db.system('первый вход: создание кабинета');
    const lockKey = `site-account:${identity.telegramId.toString()}`;
    const result = await system.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
      const existing = (await tx.siteAccountMember.findFirst({
        where: { telegramId: identity.telegramId },
        orderBy: { createdAt: 'desc' },
      })) as MemberRow | null;
      if (existing) return { row: existing, created: false };
      const account = await tx.siteAccount.create({
        data: { verifyToken: newVerifyToken() },
      });
      const row = (await tx.siteAccountMember.create({
        data: {
          accountId: account.id,
          telegramId: identity.telegramId,
          role: 'owner',
          productRoles: { ...OWNER_PRODUCT_ROLES },
        },
      })) as MemberRow;
      return { row, created: true };
    });
    const membership = toMembership(result.row);
    if (!membership) {
      throw new Error('ensureAccount: участник с неизвестной ролью');
    }
    return { membership, created: result.created };
  }

  async accountInfo(
    membership: AccountMembership,
    created: boolean,
  ): Promise<AccountInfo> {
    const db = this.db.forAccount(membership.accountId);
    const account = await db.siteAccount.findUnique({
      where: { id: membership.accountId },
    });
    if (!account) {
      throw forbidden('ACCOUNT_REQUIRED', 'Кабинет не найден');
    }
    const manage = canManage(membership.role);
    const info: AccountInfo = {
      account: {
        id: account.id,
        type: account.type === 'agency' ? 'agency' : 'owner',
        region: account.region,
        verifyToken: manage ? account.verifyToken : null,
      },
      me: memberView(membership),
      accounts: (await this.memberships(membership.telegramId)).map((m) => ({
        id: m.accountId,
        role: m.role,
      })),
      created,
    };
    if (manage) {
      const rows = (await db.siteAccountMember.findMany({
        orderBy: { createdAt: 'asc' },
      })) as MemberRow[];
      info.members = rows
        .map(toMembership)
        .filter((m): m is AccountMembership => m !== null)
        .map(memberView);
    }
    return info;
  }

  /**
   * Приглашение (только владелец — гвард маршрута). Роль `owner` выдать
   * нельзя: владелец у кабинета один. В ответе — сам токен (показывается
   * один раз), в базе — его хеш.
   */
  async createInvite(
    membership: AccountMembership,
    input: { role: unknown; productRoles?: unknown },
    now = new Date(),
  ): Promise<{ token: string; startParam: string; expiresAt: Date }> {
    const role = parseAccountRole(input.role);
    if (role !== 'manager' && role !== 'operator') {
      throw siteCoreError(
        BadRequestException,
        'INVITE_ROLE_INVALID',
        'Пригласить можно менеджера или оператора',
      );
    }
    const productRoles = validateProductRolesInput(input.productRoles);
    if (!productRoles) {
      throw siteCoreError(
        BadRequestException,
        'INVITE_ROLE_INVALID',
        'Недопустимые права по продукту',
      );
    }
    const token = newVerifyToken();
    const expiresAt = new Date(now.getTime() + INVITE_TTL_MS);
    await this.db.forAccount(membership.accountId).siteAccountInvite.create({
      data: {
        accountId: membership.accountId,
        tokenHash: hashInviteToken(token),
        role,
        productRoles,
        createdByTelegramId: membership.telegramId,
        expiresAt,
      },
    });
    return { token, startParam: `${INVITE_START_PREFIX}${token}`, expiresAt };
  }

  /**
   * Принять приглашение (`startapp=inv_<token>` из любого бота).
   * Одноразовость — условным UPDATE (`usedAt IS NULL`): два параллельных
   * принятия одного токена не создадут двух участников.
   */
  async acceptInvite(
    identity: RequestIdentity,
    rawToken: string,
    now = new Date(),
  ): Promise<AccountMembership> {
    const token = rawToken.startsWith(INVITE_START_PREFIX)
      ? rawToken.slice(INVITE_START_PREFIX.length)
      : rawToken;
    const invalid = () =>
      forbidden(
        'INVITE_INVALID',
        'Приглашение недействительно или уже использовано — попросите новое',
      );
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) throw invalid();
    const system = this.db.system('приглашение: поиск по хешу токена');
    const invite = await system.siteAccountInvite.findUnique({
      where: { tokenHash: hashInviteToken(token) },
    });
    if (!invite || invite.usedAt || invite.expiresAt <= now) throw invalid();

    const existing = (await this.memberships(identity.telegramId)).find(
      (m) => m.accountId === invite.accountId,
    );
    const claimed = await system.siteAccountInvite.updateMany({
      where: { id: invite.id, usedAt: null },
      data: { usedAt: now, usedByTelegramId: identity.telegramId },
    });
    if (claimed.count !== 1) throw invalid();
    // Уже участник — права не понижаем и не повышаем приглашением.
    if (existing) return existing;

    const role = parseAccountRole(invite.role);
    if (role !== 'manager' && role !== 'operator') throw invalid();
    const row = (await this.db
      .forAccount(invite.accountId)
      .siteAccountMember.create({
        data: {
          accountId: invite.accountId,
          telegramId: identity.telegramId,
          role,
          productRoles: parseProductRoles(invite.productRoles),
        },
      })) as MemberRow;
    const m = toMembership(row);
    if (!m) throw invalid();
    return m;
  }
}
