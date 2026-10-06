/**
 * Кабинет (`SiteAccount`) и его участники — ядро site-core (ТЗ помощника
 * §3.0, §3.2; QA-ТЗ §1.5, §2.1).
 *
 * Человек узнаётся по `telegramId` — он один у человека в обоих ботах,
 * поэтому вход через помощника и через QA приводит в ОДИН кабинет с теми
 * же сайтами и подтверждениями. Кабинет создаётся при первом входе.
 */

import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
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
  /** Э3 (H): id участника — для PATCH/DELETE /sites/account/members/:memberId. */
  memberId: string;
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
    memberId: m.memberId,
    telegramId: m.telegramId.toString(),
    role: m.role,
    productRoles: m.productRoles,
  };
}

const canManage = (role: AccountRole) => role === 'owner' || role === 'manager';

/**
 * Кабинет по умолчанию (запрос без `X-Site-Account`), аудит Н-1: СВОЙ
 * (`owner`), иначе самый ранний по членству. НЕ «последний, куда
 * добавили»: иначе одно принятое приглашение молча переносило бы человека
 * в чужой кабинет, и сайт/подтверждение домена/тестовые учётки с паролями
 * он заводил бы там, думая, что у себя. `all` — как отдаёт
 * `memberships()`: новые первыми, поэтому самый ранний — последний.
 */
export function defaultMembership(
  all: readonly AccountMembership[],
): AccountMembership | null {
  return all.find((m) => m.role === 'owner') ?? all[all.length - 1] ?? null;
}

/** Хвост id кабинета для превью приглашения — различимо, но не весь id. */
export function accountTail(id: string): string {
  return id.slice(-6);
}

/**
 * `GET /sites/account/invites/:token/preview` (аудит Н-1): что человек
 * увидит ДО принятия. Только то, что нужно для решения: чей кабинет (хвост
 * id, тип), кто пригласил (если известно), какая роль и права, срок. Ни
 * полного id кабинета, ни токена, ни участников, ни сайтов.
 */
export interface InvitePreview {
  account: { tail: string; type: 'owner' | 'agency' };
  /**
   * Имя пригласившего в Telegram — из его последнего входа в веб-кабинет
   * (в базе имён участников нет). `null` — неизвестно.
   */
  inviter: { username: string | null; firstName: string | null } | null;
  role: 'manager' | 'operator';
  productRoles: ProductRoles;
  expiresAt: Date;
  /** Человек уже в этом кабинете — принятие ничего не изменит. */
  alreadyMember: boolean;
}

/** `inv_<токен>` или голый токен → токен; битый — `null`. */
function inviteTokenOf(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const token = raw.startsWith(INVITE_START_PREFIX)
    ? raw.slice(INVITE_START_PREFIX.length)
    : raw;
  return /^[A-Za-z0-9_-]{16,128}$/.test(token) ? token : null;
}

const inviteInvalid = () =>
  forbidden(
    'INVITE_INVALID',
    'Приглашение недействительно или уже использовано — попросите новое',
  );

/** Коды участников (Э3, H) — конверт как у siteCoreError (`error` + `code`). */
function memberError(
  Ctor: new (body: Record<string, unknown>) => HttpException,
  code: 'MEMBER_NOT_FOUND' | 'MEMBER_LAST_OWNER' | 'MEMBER_ROLES_INVALID',
  message: string,
): HttpException {
  return new Ctor({ error: code, code, message });
}

@Injectable()
export class AccountService {
  private readonly logger = new Logger(AccountService.name);

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
   * если человек в нём состоит; иначе — свой (`owner`), а нет своего —
   * самый ранний (`defaultMembership`, аудит Н-1). Новичок по приглашению
   * своего кабинета не имеет — он и так попадает в кабинет пригласившего.
   */
  async resolveMembership(
    telegramId: bigint,
    requestedAccountId?: string,
  ): Promise<AccountMembership | null> {
    const all = await this.memberships(telegramId);
    if (requestedAccountId) {
      return all.find((m) => m.accountId === requestedAccountId) ?? null;
    }
    return defaultMembership(all);
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
      // Тот же выбор, что у resolveMembership: свой, иначе самый ранний.
      const existing = ((await tx.siteAccountMember.findFirst({
        where: { telegramId: identity.telegramId, role: 'owner' },
        orderBy: { createdAt: 'asc' },
      })) ??
        (await tx.siteAccountMember.findFirst({
          where: { telegramId: identity.telegramId },
          orderBy: { createdAt: 'asc' },
        }))) as MemberRow | null;
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

  /** Живое приглашение по токену (не использовано, не истекло) или 403. */
  private async liveInvite(rawToken: unknown, now: Date) {
    const token = inviteTokenOf(rawToken);
    if (!token) throw inviteInvalid();
    const invite = await this.db
      .system('приглашение: поиск по хешу токена')
      .siteAccountInvite.findUnique({
        where: { tokenHash: hashInviteToken(token) },
      });
    if (!invite || invite.usedAt || invite.expiresAt <= now) {
      throw inviteInvalid();
    }
    return invite;
  }

  /**
   * Превью приглашения БЕЗ принятия (аудит Н-1): экран «Вас приглашают в
   * чужой кабинет» показывает это до кнопки «Принять». Ничего не пишет,
   * токен не тратит; недействительное — тот же `INVITE_INVALID`, что у
   * принятия (по ответу не отличить «нет такого» от «использовано»).
   */
  async previewInvite(
    identity: RequestIdentity,
    rawToken: unknown,
    now = new Date(),
  ): Promise<InvitePreview> {
    const invite = await this.liveInvite(rawToken, now);
    const role = parseAccountRole(invite.role);
    if (role !== 'manager' && role !== 'operator') throw inviteInvalid();
    const account = await this.db
      .forAccount(invite.accountId)
      .siteAccount.findUnique({ where: { id: invite.accountId } });
    if (!account) throw inviteInvalid();
    const alreadyMember = (await this.memberships(identity.telegramId)).some(
      (m) => m.accountId === invite.accountId,
    );
    return {
      account: {
        tail: accountTail(account.id),
        type: account.type === 'agency' ? 'agency' : 'owner',
      },
      inviter: await this.inviterName(invite.createdByTelegramId),
      role,
      productRoles: parseProductRoles(invite.productRoles),
      expiresAt: invite.expiresAt,
      alreadyMember,
    };
  }

  /**
   * Имя пригласившего: имён участников в базе нет, есть только у сессий
   * веб-кабинета (данные виджета входа Telegram). Не нашли или сбой —
   * `null`: превью без имени лучше, чем без превью.
   */
  private async inviterName(
    telegramId: bigint,
  ): Promise<InvitePreview['inviter']> {
    try {
      const row = await this.db
        .system('превью приглашения: имя пригласившего из его веб-входа')
        .siteWebSession.findFirst({
          where: {
            telegramId,
            OR: [{ username: { not: null } }, { firstName: { not: null } }],
          },
          orderBy: { createdAt: 'desc' },
          select: { username: true, firstName: true },
        });
      if (!row) return null;
      return {
        username: row.username ? row.username.slice(0, 64) : null,
        firstName: row.firstName ? row.firstName.slice(0, 64) : null,
      };
    } catch (e) {
      this.logger.warn(
        `превью приглашения: имя пригласившего не прочитано (${String(e)})`,
      );
      return null;
    }
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
    const invalid = inviteInvalid;
    const invite = await this.liveInvite(rawToken, now);
    const system = this.db.system('приглашение: одноразовое принятие');

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

  /**
   * Э3 (H): смена роли/прав участника — только владелец (гвард маршрута).
   * Владелец у кабинета один: его роль не меняется (`MEMBER_LAST_OWNER`),
   * его права — «Всё» и так. `productRoles` — частично: переданные ключи
   * заменяют свои, остальные остаются (опечатка — 400, а не «тихо none»).
   */
  async updateMember(
    membership: AccountMembership,
    memberId: string,
    input: { role?: unknown; productRoles?: unknown },
  ): Promise<AccountInfo> {
    const db = this.db.forAccount(membership.accountId);
    const row = (await db.siteAccountMember.findFirst({
      where: { id: memberId },
    })) as MemberRow | null;
    if (!row) {
      throw memberError(
        NotFoundException,
        'MEMBER_NOT_FOUND',
        'Участник не найден',
      );
    }
    const current = toMembership(row);
    if (!current) {
      throw memberError(
        NotFoundException,
        'MEMBER_NOT_FOUND',
        'Участник не найден',
      );
    }
    if (current.role === 'owner') {
      throw memberError(
        ConflictException,
        'MEMBER_LAST_OWNER',
        'Владелец кабинета один — его роль не меняется',
      );
    }
    const data: { role?: AccountRole; productRoles?: ProductRoles } = {};
    if (input.role !== undefined) {
      const role = parseAccountRole(input.role);
      if (role !== 'manager' && role !== 'operator') {
        throw memberError(
          BadRequestException,
          'MEMBER_ROLES_INVALID',
          'Роль: менеджер или оператор',
        );
      }
      data.role = role;
    }
    if (input.productRoles !== undefined) {
      const raw = input.productRoles;
      const partial =
        raw !== null && typeof raw === 'object' && !Array.isArray(raw)
          ? (raw as Record<string, unknown>)
          : null;
      const checked = partial ? validateProductRolesInput(partial) : null;
      if (!partial || !checked) {
        throw memberError(
          BadRequestException,
          'MEMBER_ROLES_INVALID',
          'Недопустимые права по продукту',
        );
      }
      data.productRoles = {
        ...current.productRoles,
        ...(Object.fromEntries(
          Object.keys(partial).map((k) => [
            k,
            checked[k as keyof ProductRoles],
          ]),
        ) as Partial<ProductRoles>),
      };
    }
    if (Object.keys(data).length) {
      await db.siteAccountMember.update({
        where: { id: memberId },
        data,
      });
    }
    return this.accountInfo(membership, false);
  }

  /**
   * Э3 (H): удалить участника. Владелец — любого, кроме себя (последний
   * владелец — `MEMBER_LAST_OWNER`); участник — только себя («выйти из
   * кабинета»). Ответ — кабинет, в котором человек теперь работает
   * (после выхода — следующий его кабинет или новый свой).
   */
  async deleteMember(
    membership: AccountMembership,
    memberId: string,
    identity: RequestIdentity,
  ): Promise<AccountInfo> {
    const db = this.db.forAccount(membership.accountId);
    const row = (await db.siteAccountMember.findFirst({
      where: { id: memberId },
    })) as MemberRow | null;
    const target = row ? toMembership(row) : null;
    if (!target) {
      throw memberError(
        NotFoundException,
        'MEMBER_NOT_FOUND',
        'Участник не найден',
      );
    }
    const self = target.memberId === membership.memberId;
    if (!self && membership.role !== 'owner') {
      throw forbidden(
        'ACCOUNT_ROLE_REQUIRED',
        'Удалить другого участника может только владелец кабинета',
      );
    }
    if (target.role === 'owner') {
      throw memberError(
        ConflictException,
        'MEMBER_LAST_OWNER',
        'Владелец кабинета не может удалить себя — кабинет останется без владельца',
      );
    }
    await db.siteAccountMember.deleteMany({ where: { id: memberId } });
    if (!self) return this.accountInfo(membership, false);
    const { membership: next, created } = await this.ensureAccount(identity);
    return this.accountInfo(next, created);
  }
}
