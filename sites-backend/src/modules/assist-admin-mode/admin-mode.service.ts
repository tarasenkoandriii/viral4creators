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
import type { ActionLogTx } from './action-log.service';
import { adminError } from './admin-errors';
import {
  ASSIST_ROLE_RE,
  PatchAdminModeDto,
  ROLE_KEY_RE,
} from './admin-mode.dto';
import {
  parseTaskMinutes,
  readTaskMinutes,
} from '../assist-admin-analytics/admin-label-schema';
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
  /** Р-З9-17: тестовый ключ ходит в коннекторы (умолчание — нет). */
  testKeyConnectors: boolean;
  /** Р-З10-16 (Ш6 (7)): «админка» — Telegram Mini App (Telegram Web предком). */
  adminTmaFrame: boolean;
  /** Р-З10-15 (Ш6 (4)): подпись кнопки (`data-label`); null — по умолчанию. */
  widgetLabel: string | null;
  /** №57: разметка диалогов ИИ, минуты на тип задачи, отчёт недели. */
  analyticsLabeling: boolean;
  analyticsTaskMinutes: Record<string, number>;
  weeklyReport: boolean;
  /** Код вставки в админку (7b): null — нет публичного ключа сайта. */
  snippet: { origin: string; tag: string; csp: string } | null;
}

/** AAD владельца секрета подписи JWT сайта. */
export const IDENTITY_SECRET_OWNER = 'identity';

/** Строгий разбор карты ролей: мусор — 400, а не «тихо пусто». */
export function parseRoleMap(v: unknown): Record<string, string> | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length > 30) return null;
  for (const [k, val] of entries) {
    if (!ROLE_KEY_RE.test(k) || typeof val !== 'string') return null;
    if (!ASSIST_ROLE_RE.test(val)) return null;
  }
  // Аудит З13 P3-1: собственные свойства (без сеттера прототипа); ключ
  // «__proto__» и так отвергает ROLE_KEY_RE.
  return Object.fromEntries(entries) as Record<string, string>;
}

/**
 * Роль помощника «владелец»: её сопоставление открывает редактор карты
 * «Админки» (Р-З11-А2-11) и даёт инструменты роли `owner` в чате.
 */
export const ADMIN_OWNER_ROLE = 'owner';
/** Пар в карте ролей не больше (как у `parseRoleMap`). */
export const ROLE_MAP_MAX = 30;

/** Замок правок карты ролей сайта (PATCH и «моя роль → owner»). */
const roleMapLock = (siteId: string) => `assist-admin-rolemap:${siteId}`;

const hasOwn = (o: object, k: string) =>
  Object.prototype.hasOwnProperty.call(o, k);

/**
 * Строка журнала изменения карты ролей — в ТОЙ ЖЕ транзакции, что и запись
 * карты (аудит З13 P2-1): сбой журнала откатывает изменение прав.
 */
export type RoleMapJournal = (
  tx: ActionLogTx,
  request: Record<string, unknown>,
) => Promise<void>;

export interface RoleMapChange {
  before: Record<string, string>;
  after: Record<string, string>;
  /** Прежнее значение пары (null — роли в карте не было). */
  previous: string | null;
  changed: boolean;
}

/**
 * Р-З13-Б2: разница карт ролей для журнала — новые/изменённые пары и
 * снятые ключи (роли заказчика — идентификаторы, не персональные данные).
 */
export function roleMapDiff(
  before: Record<string, string>,
  after: Record<string, string>,
): { set: Record<string, string>; removed: string[] } | null {
  const set: Record<string, string> = Object.fromEntries(
    Object.entries(after).filter(
      ([k, v]) => !hasOwn(before, k) || before[k] !== v,
    ),
  );
  const removed = Object.keys(before)
    .filter((k) => !hasOwn(after, k))
    .sort();
  return Object.keys(set).length || removed.length ? { set, removed } : null;
}

/**
 * Условие перевыпуска секрета (Р-З9-18): `undefined` — без условия (старые
 * сборки TMA); null — секрета ещё нет; ISO — тот самый выпуск.
 */
export function expectedIssueWhere<K extends string>(
  column: K,
  expected: string | null | undefined,
): Partial<Record<K, Date | null>> {
  if (expected === undefined) return {};
  return { [column]: expected === null ? null : new Date(expected) } as Partial<
    Record<K, Date | null>
  >;
}

/** 409: секрет перевыпустили параллельно — показанный кем-то другим действует. */
export function secretChanged() {
  return adminError(
    409,
    'ADMIN_SECRET_CHANGED',
    'Секрет уже перевыпущен в другом окне — обновите экран; действует последний показанный секрет',
  );
}

function attr(v: string): string {
  return v.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

/** Р-З10-15: подпись кнопки — до 40 символов (не байт). */
export const WIDGET_LABEL_MAX = 40;

/**
 * Подпись кнопки помощника на странице админки (Ш6 (4), Р-З10-15): пробелы
 * схлопываются, пусто — null (подпись по умолчанию); управляющие символы,
 * `<`/`>` (без HTML) и длина > 40 — 400. Та же проверка — в `admin.js`
 * (атрибут правят руками в теге): вторая линия, не доверие этой.
 */
export function cleanWidgetLabel(v: string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const t = v.replace(/\s+/g, ' ').trim();
  if (!t) return null;
  if (
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f-\u009f<>]/.test(t) ||
    Array.from(t).length > WIDGET_LABEL_MAX
  ) {
    throw adminError(
      400,
      'ADMIN_LABEL_INVALID',
      `Подпись кнопки — до ${WIDGET_LABEL_MAX} символов, без < и >`,
    );
  }
  return t;
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
      testKeyConnectors: s.testKeyConnectors,
      adminTmaFrame: s.adminTmaFrame,
      widgetLabel: s.widgetLabel,
      analyticsLabeling: s.analyticsLabeling,
      analyticsTaskMinutes: readTaskMinutes(s.analyticsTaskMinutes),
      weeklyReport: s.weeklyReport,
      snippet: pk
        ? {
            origin,
            // Р-З10-15: своя подпись кнопки — атрибутом `data-label`.
            tag: `<script async src="${attr(origin + WIDGET_LOADER_PATH)}" data-site="${attr(pk)}" data-mode="${WIDGET_ADMIN_MODE}"${s.widgetLabel ? ` data-label="${attr(s.widgetLabel)}"` : ''} data-identity="<JWT сотрудника от вашего бэкенда>"></script>`,
            csp: `script-src ${origin}; frame-src ${origin}`,
          }
        : null,
    };
  }

  /**
   * `journal` (заход 13, аудит P2-1/P2-2): карта ролей в PATCH — под замком
   * карты ролей сайта (тот же, что у «моя роль → owner»): прежняя карта
   * читается под замком, разница пишется строкой журнала в той же
   * транзакции; сбой журнала — изменение откатывается целиком.
   */
  async patch(
    m: AccountMembership,
    siteId: string,
    dto: PatchAdminModeDto,
    journal?: RoleMapJournal,
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
    if (dto.testKeyConnectors !== undefined) {
      data.testKeyConnectors = dto.testKeyConnectors;
    }
    if (dto.adminTmaFrame !== undefined) data.adminTmaFrame = dto.adminTmaFrame;
    if (dto.widgetLabel !== undefined) {
      data.widgetLabel = cleanWidgetLabel(dto.widgetLabel);
    }
    if (dto.analyticsLabeling !== undefined) {
      data.analyticsLabeling = dto.analyticsLabeling;
    }
    if (dto.analyticsTaskMinutes !== undefined) {
      const tm = parseTaskMinutes(dto.analyticsTaskMinutes);
      if (!tm) {
        throw adminError(
          400,
          'ADMIN_TASK_MINUTES_INVALID',
          'Минуты на тип задачи: известные типы, целые 0…480',
        );
      }
      data.analyticsTaskMinutes = tm;
    }
    if (dto.weeklyReport !== undefined) data.weeklyReport = dto.weeklyReport;
    if (data.roleMap !== undefined) {
      const after = data.roleMap as Record<string, string>;
      await this.db.forAccount(m.accountId).$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${roleMapLock(siteId)}))`;
        const s = await tx.assistAdminSettings.findFirstOrThrow({
          where: { siteId },
          select: { roleMap: true },
        });
        await tx.assistAdminSettings.updateMany({ where: { siteId }, data });
        const diff = roleMapDiff(parseRoleMap(s.roleMap) ?? {}, after);
        if (diff && journal) await journal(tx, diff);
      });
    } else if (Object.keys(data).length) {
      await this.db
        .forAccount(m.accountId)
        .assistAdminSettings.updateMany({ where: { siteId }, data });
    }
    return this.view(m, siteId);
  }

  /**
   * Р-З13-Б1 (хвост захода 11, Р-З11-А2-11): «сопоставить мою роль у
   * заказчика с ролью помощника `owner`» — одна пара карты ролей; прочие
   * пары не трогаются. Пара уже `owner` — без записи.
   *  - замок карты ролей сайта (общий с PATCH) сериализует правки карты;
   *  - `expectedPrevious` (аудит P3-6): значение пары, которое видел экран
   *    (null — пары не было); не совпало — 409 `ADMIN_ROLEMAP_CHANGED`,
   *    замена по устаревшему подтверждению не проходит;
   *  - `journal` — строка журнала в той же транзакции (аудит P2-1/P3-2).
   */
  async mapOwnerRole(
    m: AccountMembership,
    siteId: string,
    role: string,
    opts: {
      expectedPrevious?: string | null;
      journal?: RoleMapJournal;
    } = {},
  ): Promise<RoleMapChange> {
    await this.requireSite(m.accountId, siteId);
    if (!ROLE_KEY_RE.test(role))
      throw adminError(
        400,
        'ADMIN_ROLEMAP_INVALID',
        'Роль у вас: 1–64 символа — буквы, цифры, _ . : -',
      );
    await this.ensureSettings(m.accountId, siteId);
    return this.db.forAccount(m.accountId).$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${roleMapLock(siteId)}))`;
      const s = await tx.assistAdminSettings.findFirstOrThrow({
        where: { siteId },
        select: { roleMap: true },
      });
      const before = parseRoleMap(s.roleMap) ?? {};
      const previous = hasOwn(before, role) ? before[role] : null;
      if (previous === ADMIN_OWNER_ROLE)
        return { before, after: before, previous, changed: false };
      if (
        opts.expectedPrevious !== undefined &&
        opts.expectedPrevious !== previous
      )
        throw adminError(
          409,
          'ADMIN_ROLEMAP_CHANGED',
          'Карту ролей изменили в другом окне — проверьте и повторите',
        );
      if (previous === null && Object.keys(before).length >= ROLE_MAP_MAX)
        throw adminError(
          409,
          'ADMIN_ROLEMAP_INVALID',
          `В карте ролей уже ${ROLE_MAP_MAX} пар — удалите лишнюю`,
        );
      const after: Record<string, string> = Object.fromEntries([
        ...Object.entries(before).filter(([k]) => k !== role),
        [role, ADMIN_OWNER_ROLE],
      ]);
      await tx.assistAdminSettings.updateMany({
        where: { siteId },
        data: { roleMap: after },
      });
      if (opts.journal)
        await opts.journal(tx, { role, from: previous, to: ADMIN_OWNER_ROLE });
      return { before, after, previous, changed: true };
    });
  }

  /**
   * Выпустить (перевыпустить) секрет подписи employee-JWT. Открытый текст —
   * только в этом ответе; прежний секрет перестаёт действовать сразу.
   */
  async issueIdentitySecret(
    m: AccountMembership,
    siteId: string,
    expectedSetAt?: string | null,
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
    // Р-З9-18: условный UPDATE по выпуску, который видела TMA — из двух
    // одновременных перевыпусков действует ровно один, второй — 409.
    const w = await this.db
      .forAccount(m.accountId)
      .assistAdminSettings.updateMany({
        where: {
          siteId,
          ...expectedIssueWhere('identitySecretSetAt', expectedSetAt),
        },
        data: {
          identitySecretEnc: sealed.ciphertext,
          identityKeyVersion: sealed.keyVersion,
          identitySecretSetAt: now,
          identitySecretSetByTelegramId: m.telegramId,
        },
      });
    if (w.count !== 1) throw secretChanged();
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
