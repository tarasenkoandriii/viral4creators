/**
 * Режим «Админка» — экран кабинета (ТЗ §3.8 п.1–2, §5.1, §5.2 слой 1,
 * §5.6). Только `assistAdmin: owner` (гвард контроллера).
 *
 *  - включение — нужен хотя бы один verified-хост сайта (7a) и тариф с
 *    «Админка: чтение» (§5.2 слой 1: Business/Pro);
 *  - способ `script|both` (7b) — нужны verified-хосты САМОЙ админки
 *    (`adminHostIds`): из них — frame-ancestors iframe `wa.`;
 *  - секрет подписи employee-JWT — выпускается здесь, шифруется
 *    ASSIST_SECRETS_KEY с AAD (§5.6), открытый текст — один раз в ответе;
 *  - карта ролей JWT → роли помощника; роль сотрудников TMA.
 */
import { randomBytes } from 'crypto';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { SitesDb } from '../../prisma/sites-db.service';
import { adminWidgetOrigin } from '../../config/admin-env';
import { WIDGET_ADMIN_MODE, WIDGET_LOADER_PATH } from '../../brand';
import { readState } from '../assist-billing/public/entitlements';
import { ASSIST_PLANS } from '../assist-billing/plans';
import type { AccountMembership } from '../site-core/account/roles';
import { HostAccessService } from '../site-core/ownership/host-access.service';
import { evaluateHostAccess } from '../site-core/ownership/host-access';
import { notFoundSite } from '../site-core/site-core.constants';
import { adminError } from './admin-errors';
import { ASSIST_ROLE_RE, PatchAdminModeDto } from './admin-mode.dto';
import {
  AdminSecretsError,
  loadAdminKeyring,
  openAdminSecret,
  sealAdminSecret,
} from './admin-secrets-crypto';

export type AdminAccess = 'tma' | 'script' | 'both';

export interface AdminHostView {
  id: string;
  host: string;
  status: string;
  verified: boolean;
}

export interface AdminModeView {
  siteId: string;
  enabled: boolean;
  access: AdminAccess;
  /** Есть ли у сайта хоть один verified-хост (условие включения, §3.8 п.1). */
  siteVerified: boolean;
  /** Тариф даёт «Админка: чтение» (§5.2 слой 1). */
  planAllows: boolean;
  hosts: AdminHostView[];
  adminHostIds: string[];
  identitySecret: { set: boolean; setAt: string | null };
  instructions: string | null;
  roleMap: Record<string, string>;
  tmaEmployeeRole: string | null;
  statsPerEmployee: boolean;
  /** Э8: тариф даёт «Админка: действия» (Pro). */
  planAllowsActions: boolean;
  actionsDailyCap: number;
  notifyDanger: boolean;
  /** Код вставки в админку (7b): null — нет публичного ключа сайта. */
  snippet: { origin: string; tag: string; csp: string } | null;
}

/** AAD владельца секрета подписи JWT сайта. */
export const IDENTITY_SECRET_OWNER = 'identity';

const ROLE_KEY_RE = /^[\p{L}\p{N}_.:-]{1,64}$/u;

/** Строгий разбор карты ролей: мусор — 400, а не «тихо пусто». */
export function parseRoleMap(v: unknown): Record<string, string> | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length > 30) return null;
  const out: Record<string, string> = {};
  for (const [k, val] of entries) {
    if (!ROLE_KEY_RE.test(k) || typeof val !== 'string') return null;
    if (!ASSIST_ROLE_RE.test(val)) return null;
    out[k] = val;
  }
  return out;
}

function attr(v: string): string {
  return v.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

@Injectable()
export class AdminModeService {
  /** Тесты подменяют env (ключ секретов). */
  env: NodeJS.ProcessEnv = process.env;

  constructor(
    private readonly db: SitesDb,
    private readonly prisma: PrismaService,
    private readonly hostAccess: HostAccessService,
  ) {}

  async requireSite(accountId: string, siteId: string) {
    const site = await this.db.forAccount(accountId).site.findFirst({
      where: { id: siteId },
      select: { id: true, name: true },
    });
    if (!site) throw notFoundSite();
    return site;
  }

  async ensureSettings(accountId: string, siteId: string) {
    const db = this.db.forAccount(accountId);
    await db.assistAdminSettings.createMany({
      data: [{ accountId, siteId }],
      skipDuplicates: true,
    });
    return db.assistAdminSettings.findFirstOrThrow({ where: { siteId } });
  }

  /** Тариф даёт «Админка: чтение» (§5.2 слой 1). */
  async planAllows(accountId: string, now = new Date()): Promise<boolean> {
    const state = await readState(this.prisma, accountId, now);
    return !!state.planId && ASSIST_PLANS[state.planId].adminRead;
  }

  /** Э8: тариф даёт «Админка: действия» (§5.2 слой 1 — Pro). */
  async planAllowsActions(
    accountId: string,
    now = new Date(),
  ): Promise<boolean> {
    const state = await readState(this.prisma, accountId, now);
    return !!state.planId && ASSIST_PLANS[state.planId].adminActions;
  }

  private async hostsOf(accountId: string, siteId: string, now: Date) {
    const rows = await this.db.forAccount(accountId).siteHost.findMany({
      where: { siteId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((h) => ({
      row: h,
      view: {
        id: h.id,
        host: h.host,
        status: h.status,
        verified: evaluateHostAccess(h, 'assist-admin', now).ok,
      } satisfies AdminHostView,
    }));
  }

  async view(m: AccountMembership, siteId: string): Promise<AdminModeView> {
    const now = new Date();
    await this.requireSite(m.accountId, siteId);
    const s = await this.ensureSettings(m.accountId, siteId);
    const hosts = await this.hostsOf(m.accountId, siteId, now);
    const assist = await this.db
      .forAccount(m.accountId)
      .assistSite.findFirst({ where: { siteId }, select: { publicKey: true } });
    const origin = adminWidgetOrigin(this.env);
    const pk = assist?.publicKey ?? null;
    return {
      siteId,
      enabled: s.adminModeEnabled,
      access: s.adminAccess as AdminAccess,
      siteVerified: hosts.some((h) => h.view.verified),
      planAllows: await this.planAllows(m.accountId, now),
      hosts: hosts.map((h) => h.view),
      adminHostIds: s.adminHostIds,
      identitySecret: {
        set: !!s.identitySecretEnc,
        setAt: s.identitySecretSetAt?.toISOString() ?? null,
      },
      instructions: s.instructions,
      roleMap: parseRoleMap(s.roleMap) ?? {},
      tmaEmployeeRole: s.tmaEmployeeRole,
      statsPerEmployee: s.statsPerEmployee,
      planAllowsActions: await this.planAllowsActions(m.accountId, now),
      actionsDailyCap: s.actionsDailyCap,
      notifyDanger: s.notifyDanger,
      snippet: pk
        ? {
            origin,
            tag: `<script async src="${attr(origin + WIDGET_LOADER_PATH)}" data-site="${attr(pk)}" data-mode="${WIDGET_ADMIN_MODE}" data-identity="<JWT сотрудника от вашего бэкенда>"></script>`,
            csp: `script-src ${origin}; frame-src ${origin}`,
          }
        : null,
    };
  }

  async patch(
    m: AccountMembership,
    siteId: string,
    dto: PatchAdminModeDto,
  ): Promise<AdminModeView> {
    const now = new Date();
    await this.requireSite(m.accountId, siteId);
    const s = await this.ensureSettings(m.accountId, siteId);
    const hosts = await this.hostsOf(m.accountId, siteId, now);
    const data: Prisma.AssistAdminSettingsUpdateManyMutationInput = {};

    const adminHostIds = dto.adminHostIds ?? s.adminHostIds;
    if (dto.adminHostIds !== undefined) {
      for (const id of dto.adminHostIds) {
        const h = hosts.find((x) => x.view.id === id);
        if (!h) {
          throw adminError(
            400,
            'ADMIN_HOST_INVALID',
            'Хост не принадлежит этому сайту',
          );
        }
        if (!h.view.verified) {
          throw adminError(
            409,
            'ADMIN_HOST_INVALID',
            `Владение хостом ${h.view.host} не подтверждено`,
          );
        }
      }
      data.adminHostIds = [...new Set(dto.adminHostIds)];
    }
    const access = dto.access ?? (s.adminAccess as AdminAccess);
    if (dto.access !== undefined) data.adminAccess = dto.access;
    const enabled = dto.enabled ?? s.adminModeEnabled;
    if (enabled && (access === 'script' || access === 'both')) {
      if (adminHostIds.length === 0) {
        throw adminError(
          409,
          'ADMIN_ACCESS_INVALID',
          'Для скрипта в админке укажите подтверждённый хост самой админки',
        );
      }
    }
    if (dto.enabled === true && !s.adminModeEnabled) {
      if (!hosts.some((h) => h.view.verified)) {
        throw adminError(
          409,
          'ADMIN_SITE_NOT_VERIFIED',
          'Нужен хотя бы один подтверждённый хост сайта',
        );
      }
      if (!(await this.planAllows(m.accountId, now))) {
        throw adminError(
          402,
          'ADMIN_PLAN_REQUIRED',
          '«Админка: чтение» — в тарифах Business и Pro',
        );
      }
    }
    if (dto.enabled !== undefined) data.adminModeEnabled = dto.enabled;
    if (dto.instructions !== undefined) {
      data.instructions = dto.instructions?.trim() || null;
    }
    if (dto.roleMap !== undefined) {
      const rm = parseRoleMap(dto.roleMap);
      if (!rm) {
        throw adminError(
          400,
          'ADMIN_ROLEMAP_INVALID',
          'Карта ролей: до 30 пар «роль у вас → роль помощника (a-z, 0-9, _ -)»',
        );
      }
      data.roleMap = rm;
    }
    if (dto.tmaEmployeeRole !== undefined) {
      data.tmaEmployeeRole = dto.tmaEmployeeRole || null;
    }
    if (dto.statsPerEmployee !== undefined) {
      data.statsPerEmployee = dto.statsPerEmployee;
    }
    if (dto.actionsDailyCap !== undefined) {
      data.actionsDailyCap = dto.actionsDailyCap;
    }
    if (dto.notifyDanger !== undefined) data.notifyDanger = dto.notifyDanger;
    if (Object.keys(data).length) {
      await this.db
        .forAccount(m.accountId)
        .assistAdminSettings.updateMany({ where: { siteId }, data });
    }
    return this.view(m, siteId);
  }

  /**
   * Выпустить (перевыпустить) секрет подписи employee-JWT. Открытый текст —
   * только в этом ответе; прежний секрет перестаёт действовать сразу.
   */
  async issueIdentitySecret(
    m: AccountMembership,
    siteId: string,
  ): Promise<{
    secret: string;
    setAt: string;
    alg: 'HS256';
    aud: string;
    maxTtlSec: number;
  }> {
    await this.requireSite(m.accountId, siteId);
    await this.ensureSettings(m.accountId, siteId);
    let keyring;
    try {
      keyring = loadAdminKeyring(this.env);
    } catch (e) {
      if (e instanceof AdminSecretsError) {
        throw adminError(
          503,
          'ADMIN_SECRETS_UNAVAILABLE',
          'Хранилище секретов не настроено',
        );
      }
      throw e;
    }
    const secret = randomBytes(32).toString('base64url');
    const sealed = sealAdminSecret(
      secret,
      {
        accountId: m.accountId,
        siteId,
        ownerId: IDENTITY_SECRET_OWNER,
        purpose: 'identity-secret',
      },
      keyring,
    );
    const now = new Date();
    await this.db.forAccount(m.accountId).assistAdminSettings.updateMany({
      where: { siteId },
      data: {
        identitySecretEnc: sealed.ciphertext,
        identityKeyVersion: sealed.keyVersion,
        identitySecretSetAt: now,
        identitySecretSetByTelegramId: m.telegramId,
      },
    });
    // Сессии, выданные по прежнему секрету, гаснут сразу.
    await this.db
      .forAccount(m.accountId)
      .assistAdminSession.deleteMany({ where: { siteId } });
    return {
      secret,
      setAt: now.toISOString(),
      alg: 'HS256',
      aud: siteId,
      maxTtlSec: 15 * 60,
    };
  }

  /** Открытый секрет подписи JWT сайта (только для проверки подписи). */
  identitySecret(row: {
    accountId: string;
    siteId: string;
    identitySecretEnc: string | null;
    identityKeyVersion: string | null;
  }): string | null {
    if (!row.identitySecretEnc) return null;
    return openAdminSecret(
      { ciphertext: row.identitySecretEnc, keyVersion: row.identityKeyVersion },
      {
        accountId: row.accountId,
        siteId: row.siteId,
        ownerId: IDENTITY_SECRET_OWNER,
        purpose: 'identity-secret',
      },
      loadAdminKeyring(this.env),
    );
  }

  /** Хост сайта годится для «Админки» прямо сейчас (L1, без льготы). */
  async hostVerified(accountId: string, hostId: string): Promise<boolean> {
    try {
      await this.hostAccess.assertHostVerified(hostId, 'assist-admin', {
        accountId,
      });
      return true;
    } catch {
      return false;
    }
  }
}
