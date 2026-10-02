/**
 * Тестовые учётные записи сайта и хранилище их секретов (Э-С Ш2; аудит
 * слияния §3.2 «Тестовые учётные записи сайта (режим A)», «Модель хранения
 * учётных данных входа»; решение владельца 02.10.2026 о режиме B).
 *
 * Две зоны одного хранилища (одно шифрование, AAD, журнал, удаление):
 *
 *  - **A — реестр сайта** (`site_test_accounts` + `site_credentials`):
 *    учётки кабинета, общие для обучалки и QA. Секреты расшифровываются
 *    ТОЛЬКО по аренде на прогон (`lease` → `redeem`): учётка активна и не
 *    истекла, продукт разрешён, хост — среди её хостов и подтверждён для
 *    `<продукт>-login` (L1 без льготы 72 ч), аренда живёт 2 минуты и
 *    гасится один раз. Метаданные (есть пароль/сессия, когда брали) видят
 *    владелец и менеджеры кабинета; сами секреты — никто.
 *  - **B — личные записи** (`user_site_sessions` + `user_site_secrets`):
 *    пользователь генератора на неподтверждённом сайте. Владелец —
 *    `ownerRef` пользователя, продукт — только обучалка, аренды для QA нет,
 *    читает только владелец (через HMAC-канал генератора). Пароль хранится
 *    ради удобства — отступление от П-Т3 по решению владельца 02.10.2026.
 *
 * Каждое создание, правка, запись секрета, аренда, погашение, чтение,
 * удаление и отказ — строка журнала `site_credential_audit` (без секретов).
 * Удачная выдача секрета без строки журнала не происходит: сбой журнала —
 * отказ (503), а не «выдали молча».
 */
import {
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type {
  SiteCredential,
  SiteTestAccount,
  UserSiteSecret,
  UserSiteSession,
} from '@prisma/client';
import { SitesDb } from '../../prisma/sites-db.service';
import { AccountService } from '../site-core/account/account.service';
import type { AccountMembership } from '../site-core/account/roles';
import { registrableDomain } from '../site-core/hosts/host-normalize';
import { HostAccessService } from '../site-core/ownership/host-access.service';
import { CredentialAuditService } from './credential-audit.service';
import {
  CREDENTIAL_PURPOSES,
  CredentialAad,
  CredentialCryptoError,
  CredentialKeyring,
  CredentialPurpose,
  loadKeyring,
  openCredential,
  resealCredential,
  sealCredential,
} from './credential-crypto';
import {
  DEFAULT_LIFETIME_DAYS,
  TestAccountInput,
  TestAccountProduct,
  badInput,
} from './test-account-input';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Аренда — на один прогон: короткий срок, одно погашение. */
export const LEASE_TTL_MS = 2 * 60 * 1000;
/** Личная запись B живёт 30 дней от последнего использования (как Ш0.5). */
export const USER_SESSION_TTL_DAYS = 30;
/** Куки сессии в реестре A — 30 дней от записи (как обучалка до Ш2). */
export const COOKIES_TTL_DAYS = 30;
/** Журнал доступа хранится год. */
export const AUDIT_RETENTION_DAYS = 365;

const MANAGE_ROLES = new Set(['owner', 'manager']);
const OWNER_REF_RE = /^gen:[A-Za-z0-9_-]{1,64}$/;
const CLIENT_REF_RE = /^[a-z]{1,16}:[A-Za-z0-9_-]{1,64}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export type LeaseDenyReason =
  'frozen' | 'expired' | 'product' | 'host' | 'host_not_verified';

export type RedeemDenyReason =
  'not_found' | 'used' | 'expired' | 'actor' | 'account' | 'revoked';

export interface TestAccountView {
  id: string;
  siteId: string;
  label: string;
  role: string | null;
  plan: string | null;
  username: string | null;
  loginMethod: string;
  hostIds: string[];
  products: string[];
  /** active | frozen | expired (истёкшая — по сроку, даже если крон не дошёл). */
  status: string;
  confirmedTestAccount: boolean;
  createdBy: 'tma' | 'generator' | 'other';
  /** Что лежит в хранилище — без значений. */
  secrets: { password: boolean; loginFields: boolean; session: boolean };
  lastUsedAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
}

export interface UserSessionView {
  id: string;
  origin: string;
  label: string | null;
  products: string[];
  secrets: { password: boolean; loginFields: boolean; session: boolean };
  lastUsedAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
}

export interface LeaseResult {
  leaseId: string;
  expiresAt: Date;
}

export interface RedeemResult {
  testAccountId: string;
  label: string;
  username: string | null;
  /** Открытый текст по назначению — только в ответе на погашение аренды. */
  secrets: Partial<Record<CredentialPurpose, string>>;
}

export function credError(
  Ctor: new (body: Record<string, unknown>) => HttpException,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): HttpException {
  return new Ctor({ error: code, code, message, ...extra });
}

const notFoundAccount = () =>
  credError(
    NotFoundException,
    'TEST_ACCOUNT_NOT_FOUND',
    'Тестовая учётная запись не найдена',
  );

export function effectiveStatus(
  a: Pick<SiteTestAccount, 'status' | 'expiresAt'>,
  now: Date,
): string {
  if (a.status === 'expired' || a.expiresAt.getTime() <= now.getTime()) {
    return 'expired';
  }
  return a.status;
}

function secretFlags(purposes: Iterable<string>) {
  const set = new Set(purposes);
  return {
    password: set.has('password'),
    loginFields: set.has('login-fields'),
    session: set.has('session-cookies'),
  };
}

function createdByKind(v: string): TestAccountView['createdBy'] {
  if (v.startsWith('tma:')) return 'tma';
  if (v.startsWith('generator:')) return 'generator';
  return 'other';
}

/** Origin записи режима B: только http(s), без пути, логина и порта-мусора. */
export function normalizeOrigin(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length > 2048) {
    throw badInput('origin — ссылка на сайт');
  }
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw badInput('origin — ссылка на сайт');
  }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username) {
    throw badInput('origin — https/http без логина в ссылке');
  }
  return u.origin;
}

export function parseOwnerRef(v: unknown): string {
  if (typeof v !== 'string' || !OWNER_REF_RE.test(v)) {
    throw badInput('ownerRef — «gen:<id пользователя генератора>»');
  }
  return v;
}

export function parseClientRef(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || !CLIENT_REF_RE.test(v)) {
    throw badInput('clientRef — «project:<id>»');
  }
  return v;
}

export function parseId(v: unknown, field: string): string {
  if (typeof v !== 'string' || !ID_RE.test(v)) {
    throw badInput(`${field} — идентификатор`);
  }
  return v;
}

@Injectable()
export class SiteCredentialsService {
  /** Тесты подменяют env (ключи) — по умолчанию process.env. */
  env: NodeJS.ProcessEnv = process.env;

  constructor(
    private readonly db: SitesDb,
    private readonly accounts: AccountService,
    private readonly hosts: HostAccessService,
    private readonly audit: CredentialAuditService,
  ) {}

  // ── ключи ──────────────────────────────────────────────────────────

  /** Настроено ли хранилище — для генератора (фолбэк на старые колонки). */
  status(): { configured: boolean; currentKeyVersion: string | null } {
    try {
      const k = loadKeyring(this.env);
      return { configured: true, currentKeyVersion: k.current };
    } catch {
      return { configured: false, currentKeyVersion: null };
    }
  }

  private keyring(): CredentialKeyring {
    try {
      return loadKeyring(this.env);
    } catch (e) {
      throw credError(
        ServiceUnavailableException,
        'CREDENTIALS_NOT_CONFIGURED',
        e instanceof CredentialCryptoError && e.code === 'invalid_keys'
          ? 'Хранилище учётных данных настроено с ошибкой (SITE_CREDENTIALS_KEYS)'
          : 'Хранилище учётных данных не настроено',
      );
    }
  }

  // ── A: кабинет (экран TMA) ────────────────────────────────────────

  async list(
    accountId: string,
    siteId: string,
    now = new Date(),
  ): Promise<TestAccountView[]> {
    const db = this.db.forAccount(accountId);
    await this.requireSite(accountId, siteId);
    const rows = await db.siteTestAccount.findMany({
      where: { siteId },
      orderBy: { createdAt: 'asc' },
      include: { credentials: { select: { purpose: true, expiresAt: true } } },
    });
    return rows.map((r) => this.view(r, r.credentials, now));
  }

  async create(
    accountId: string,
    siteId: string,
    input: TestAccountInput,
    actor: string,
    opts: { clientRef?: string | null } = {},
    now = new Date(),
  ): Promise<TestAccountView> {
    await this.requireSite(accountId, siteId);
    await this.assertSiteHosts(accountId, siteId, input.hostIds ?? []);
    const keyring = input.password ? this.keyring() : null;
    const db = this.db.forAccount(accountId);
    const days = input.lifetimeDays ?? DEFAULT_LIFETIME_DAYS;
    const row = await db.siteTestAccount.create({
      data: {
        accountId,
        siteId,
        label: input.label ?? 'Test',
        role: input.role ?? null,
        plan: input.plan ?? null,
        username: input.username ?? null,
        loginMethod: input.loginMethod ?? 'password',
        hostIds: input.hostIds ?? [],
        products: input.products ?? [],
        status: input.status ?? 'active',
        createdBy: actor,
        clientRef: opts.clientRef ?? null,
        confirmedTestAccountAt: input.confirmedTestAccount ? now : null,
        expiresAt: new Date(now.getTime() + days * DAY_MS),
      },
    });
    await this.audit.append(
      {
        actor,
        action: 'create',
        scope: 'A',
        accountId,
        subjectId: row.id,
        result: 'ok',
      },
      now,
    );
    if (input.password && keyring) {
      await this.writeSecret(row, 'password', input.password, actor, keyring);
    }
    return this.reload(accountId, row.id, now);
  }

  async update(
    accountId: string,
    siteId: string,
    id: string,
    input: TestAccountInput,
    actor: string,
    now = new Date(),
  ): Promise<TestAccountView> {
    const row = await this.requireAccount(accountId, id, siteId);
    if (input.hostIds) {
      await this.assertSiteHosts(accountId, row.siteId, input.hostIds);
    }
    const keyring = input.password ? this.keyring() : null;
    const db = this.db.forAccount(accountId);
    // Истёкшая учётка оживает только явным новым сроком.
    const revive = input.lifetimeDays !== undefined;
    await db.siteTestAccount.update({
      where: { id: row.id },
      data: {
        ...(input.label !== undefined ? { label: input.label } : {}),
        ...(input.role !== undefined ? { role: input.role } : {}),
        ...(input.plan !== undefined ? { plan: input.plan } : {}),
        ...(input.username !== undefined ? { username: input.username } : {}),
        ...(input.loginMethod !== undefined
          ? { loginMethod: input.loginMethod }
          : {}),
        ...(input.hostIds !== undefined ? { hostIds: input.hostIds } : {}),
        ...(input.products !== undefined ? { products: input.products } : {}),
        ...(input.status !== undefined
          ? { status: input.status }
          : revive && row.status === 'expired'
            ? { status: 'active' }
            : {}),
        ...(input.confirmedTestAccount !== undefined
          ? {
              confirmedTestAccountAt: input.confirmedTestAccount
                ? (row.confirmedTestAccountAt ?? now)
                : null,
            }
          : {}),
        ...(revive
          ? {
              expiresAt: new Date(
                now.getTime() + (input.lifetimeDays as number) * DAY_MS,
              ),
            }
          : {}),
      },
    });
    await this.audit.append(
      {
        actor,
        action: 'update',
        scope: 'A',
        accountId,
        subjectId: row.id,
        result: 'ok',
      },
      now,
    );
    if (input.password && keyring) {
      await this.writeSecret(row, 'password', input.password, actor, keyring);
    }
    return this.reload(accountId, row.id, now);
  }

  /**
   * «Забыть»: строка учётки, её секреты и аренды удаляются (каскад) —
   * crypto-shred: шифротекстов больше нет, ключ без них ничего не открывает.
   */
  async remove(
    accountId: string,
    siteId: string | null,
    id: string,
    actor: string,
    now = new Date(),
  ): Promise<{ deleted: true }> {
    const row = await this.requireAccount(accountId, id, siteId);
    await this.db
      .forAccount(accountId)
      .siteTestAccount.deleteMany({ where: { id: row.id } });
    await this.audit.append(
      {
        actor,
        action: 'delete',
        scope: 'A',
        accountId,
        subjectId: row.id,
        result: 'ok',
      },
      now,
    );
    return { deleted: true };
  }

  /** Стереть только секреты («одноразово» обучалки): учётка остаётся. */
  async forgetSecrets(
    accountId: string,
    id: string,
    actor: string,
    now = new Date(),
  ): Promise<{ forgotten: number }> {
    const row = await this.requireAccount(accountId, id, null);
    const { count } = await this.db
      .forAccount(accountId)
      .siteCredential.deleteMany({ where: { testAccountId: row.id } });
    await this.audit.append(
      {
        actor,
        action: 'forget-secrets',
        scope: 'A',
        accountId,
        subjectId: row.id,
        result: 'ok',
      },
      now,
    );
    return { forgotten: count };
  }

  /** Записать (или стереть при `null`) один секрет учётки. */
  async putSecret(
    accountId: string,
    id: string,
    purpose: CredentialPurpose,
    plaintext: string | null,
    actor: string,
    now = new Date(),
  ): Promise<TestAccountView> {
    const row = await this.requireAccount(accountId, id, null);
    if (plaintext === null) {
      await this.db.forAccount(accountId).siteCredential.deleteMany({
        where: { testAccountId: row.id, purpose },
      });
      await this.audit.append(
        {
          actor,
          action: 'forget-secrets',
          scope: 'A',
          accountId,
          subjectId: row.id,
          purpose,
          result: 'ok',
        },
        now,
      );
    } else {
      await this.writeSecret(
        row,
        purpose,
        plaintext,
        actor,
        this.keyring(),
        now,
      );
    }
    return this.reload(accountId, row.id, now);
  }

  // ── A: генератор (внутренний API по telegramId) ───────────────────

  /**
   * Хост в кабинете, где человек владелец или менеджер: обучалка заводит и
   * читает учётки только там, где он вправе подтверждать владение.
   */
  async managedHost(
    telegramId: bigint,
    hostId: string,
  ): Promise<{ m: AccountMembership; siteId: string }> {
    for (const m of await this.accounts.memberships(telegramId)) {
      if (!MANAGE_ROLES.has(m.role)) continue;
      const host = await this.db.forAccount(m.accountId).siteHost.findFirst({
        where: { id: hostId },
        select: { siteId: true },
      });
      if (host) return { m, siteId: host.siteId };
    }
    throw credError(
      ForbiddenException,
      'HOST_NOT_MANAGED',
      'Хост не найден в кабинетах, где вы владелец или менеджер',
    );
  }

  /** Хосты сайта (для выбора «на каких хостах действует»), без служебных полей. */
  async siteHosts(
    accountId: string,
    siteId: string,
    now = new Date(),
  ): Promise<Array<{ id: string; host: string; verified: boolean }>> {
    const rows = await this.db.forAccount(accountId).siteHost.findMany({
      where: { siteId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        host: true,
        status: true,
        expiresAt: true,
        reverifyBlockedAt: true,
      },
    });
    return rows.map((h) => ({
      id: h.id,
      host: h.host,
      verified:
        h.status === 'verified' &&
        !h.reverifyBlockedAt &&
        !!h.expiresAt &&
        h.expiresAt.getTime() > now.getTime(),
    }));
  }

  /** Учётка по id в кабинетах, где человек владелец или менеджер. */
  async managedAccount(
    telegramId: bigint,
    testAccountId: string,
  ): Promise<{ m: AccountMembership; row: SiteTestAccount }> {
    for (const m of await this.accounts.memberships(telegramId)) {
      if (!MANAGE_ROLES.has(m.role)) continue;
      const row = await this.db
        .forAccount(m.accountId)
        .siteTestAccount.findFirst({ where: { id: testAccountId } });
      if (row) return { m, row };
    }
    throw notFoundAccount();
  }

  /**
   * Учётка по ключу генератора (`project:<id>`) — создать или обновить
   * (идемпотентно: повтор после таймаута не плодит строк).
   */
  async upsertByClientRef(
    accountId: string,
    siteId: string,
    clientRef: string,
    input: TestAccountInput,
    actor: string,
    now = new Date(),
  ): Promise<TestAccountView> {
    const existing = await this.db
      .forAccount(accountId)
      .siteTestAccount.findFirst({ where: { clientRef } });
    if (existing) {
      return this.update(
        accountId,
        existing.siteId,
        existing.id,
        input,
        actor,
        now,
      );
    }
    try {
      return await this.create(
        accountId,
        siteId,
        input,
        actor,
        { clientRef },
        now,
      );
    } catch (e) {
      // Гонка двух повторов: уникальный (accountId, clientRef) — второй читает.
      if ((e as { code?: string })?.code === 'P2002') {
        const again = await this.db
          .forAccount(accountId)
          .siteTestAccount.findFirst({ where: { clientRef } });
        if (again) return this.reload(accountId, again.id, now);
      }
      throw e;
    }
  }

  /** Кабинет аренды среди кабинетов, где человек владелец/менеджер. */
  async leaseAccount(
    telegramId: bigint,
    leaseId: string,
  ): Promise<string | null> {
    for (const m of await this.accounts.memberships(telegramId)) {
      if (!MANAGE_ROLES.has(m.role)) continue;
      const lease = await this.db
        .forAccount(m.accountId)
        .siteCredentialLease.findFirst({
          where: { id: leaseId },
          select: { id: true },
        });
      if (lease) return m.accountId;
    }
    return null;
  }

  // ── A: аренда ─────────────────────────────────────────────────────

  /**
   * Аренда секретов учётки на прогон. Отказ — 403 `CREDENTIAL_LEASE_DENIED`
   * с причиной; каждое решение — строка журнала.
   */
  async lease(
    accountId: string,
    req: {
      testAccountId: string;
      product: TestAccountProduct;
      hostId: string;
      actor: string;
      runRef?: string | null;
      /**
       * Продукт КАНАЛА вызывающего (аудит Ш2): канал обучалки арендует
       * только для обучалки, даже если тело просит `qa`, — иначе HMAC-канал
       * генератора открывал бы учётки, разрешённые владельцем только QA.
       */
      channel?: TestAccountProduct;
    },
    now = new Date(),
  ): Promise<LeaseResult> {
    const row = await this.requireAccount(accountId, req.testAccountId, null);
    const base = {
      actor: req.actor,
      scope: 'A' as const,
      accountId,
      subjectId: row.id,
      product: req.product,
      hostId: req.hostId,
      runRef: req.runRef ?? null,
    };
    const deny = async (reason: LeaseDenyReason, message: string) => {
      await this.audit.appendQuietly(
        { ...base, action: 'lease', result: `denied:${reason}` },
        now,
      );
      return credError(ForbiddenException, 'CREDENTIAL_LEASE_DENIED', message, {
        reason,
      });
    };
    const status = effectiveStatus(row, now);
    if (status === 'frozen') {
      throw await deny('frozen', 'Учётная запись заморожена');
    }
    if (status === 'expired') {
      throw await deny('expired', 'Срок учётной записи истёк');
    }
    if (
      (req.channel !== undefined && req.product !== req.channel) ||
      !row.products.includes(req.product)
    ) {
      throw await deny('product', 'Учётная запись не разрешена этому продукту');
    }
    if (!row.hostIds.includes(req.hostId)) {
      throw await deny('host', 'Учётная запись не действует на этом хосте');
    }
    try {
      await this.hosts.assertHostVerified(req.hostId, `${req.product}-login`, {
        accountId,
        now,
      });
    } catch {
      throw await deny(
        'host_not_verified',
        'Владение хостом не подтверждено — учётная запись заморожена до подтверждения',
      );
    }
    const lease = await this.db
      .forAccount(accountId)
      .siteCredentialLease.create({
        data: {
          accountId,
          testAccountId: row.id,
          product: req.product,
          hostId: req.hostId,
          actor: req.actor,
          runRef: req.runRef ?? null,
          expiresAt: new Date(now.getTime() + LEASE_TTL_MS),
        },
      });
    await this.audit.append({ ...base, action: 'lease', result: 'ok' }, now);
    return { leaseId: lease.id, expiresAt: lease.expiresAt };
  }

  /**
   * Погашение аренды: ОДИН раз, до срока, тем же, кто арендовал. Гонка
   * двух погашений решается `updateMany … where usedAt IS NULL`.
   */
  async redeem(
    accountId: string,
    leaseId: string,
    actor: string,
    now = new Date(),
  ): Promise<RedeemResult> {
    const db = this.db.forAccount(accountId);
    const { count } = await db.siteCredentialLease.updateMany({
      where: { id: leaseId, usedAt: null, actor, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    const lease = await db.siteCredentialLease.findFirst({
      where: { id: leaseId },
    });
    if (count !== 1 || !lease) {
      const reason: RedeemDenyReason = !lease
        ? 'not_found'
        : lease.actor !== actor
          ? 'actor'
          : lease.usedAt
            ? 'used'
            : 'expired';
      await this.audit.appendQuietly(
        {
          actor,
          action: 'redeem',
          scope: 'A',
          accountId,
          subjectId: lease?.testAccountId ?? null,
          product: lease?.product ?? null,
          hostId: lease?.hostId ?? null,
          runRef: lease?.runRef ?? null,
          result: `denied:${reason}`,
        },
        now,
      );
      throw credError(
        ForbiddenException,
        'CREDENTIAL_LEASE_INVALID',
        'Аренда недействительна: истекла, уже погашена или чужая',
        { reason },
      );
    }
    const row = await db.siteTestAccount.findFirst({
      where: { id: lease.testAccountId },
      include: { credentials: true },
    });
    const base = {
      actor,
      action: 'redeem' as const,
      scope: 'A' as const,
      accountId,
      subjectId: lease.testAccountId,
      product: lease.product,
      hostId: lease.hostId,
      runRef: lease.runRef,
    };
    // Между арендой и погашением учётку могли заморозить или удалить.
    if (!row || effectiveStatus(row, now) !== 'active') {
      await this.audit.appendQuietly(
        { ...base, result: 'denied:account' },
        now,
      );
      throw credError(
        ForbiddenException,
        'CREDENTIAL_LEASE_INVALID',
        'Учётная запись удалена, заморожена или истекла',
        { reason: 'account' satisfies RedeemDenyReason },
      );
    }
    // Аудит Ш2: за 2 минуты аренды владелец мог убрать продукт или хост из
    // учётки либо подтверждение хоста могло истечь/быть отозвано — условия
    // аренды проверяются снова, а не только в момент `lease`.
    let stillAllowed =
      row.products.includes(lease.product) &&
      row.hostIds.includes(lease.hostId);
    if (stillAllowed) {
      try {
        await this.hosts.assertHostVerified(
          lease.hostId,
          `${lease.product as TestAccountProduct}-login`,
          { accountId, now },
        );
      } catch {
        stillAllowed = false;
      }
    }
    if (!stillAllowed) {
      await this.audit.appendQuietly(
        { ...base, result: 'denied:revoked' },
        now,
      );
      throw credError(
        ForbiddenException,
        'CREDENTIAL_LEASE_INVALID',
        'Условия аренды больше не выполняются: продукт, хост или подтверждение хоста изменились',
        { reason: 'revoked' satisfies RedeemDenyReason },
      );
    }
    const keyring = this.keyring();
    const secrets: Partial<Record<CredentialPurpose, string>> = {};
    for (const c of row.credentials) {
      if (c.expiresAt && c.expiresAt.getTime() <= now.getTime()) continue;
      secrets[c.purpose as CredentialPurpose] = this.open(
        c,
        this.aadA(row, c.purpose as CredentialPurpose),
        keyring,
      );
    }
    // Журнал — ДО выдачи: секрет без строки журнала не уходит.
    await this.audit.append({ ...base, result: 'ok' }, now);
    await db.siteTestAccount.updateMany({
      where: { id: row.id },
      data: { lastUsedAt: now },
    });
    return {
      testAccountId: row.id,
      label: row.label,
      username: row.username,
      secrets,
    };
  }

  // ── B: личные записи пользователя генератора ──────────────────────

  async upsertUserSession(
    ownerRef: string,
    input: { origin: string; clientRef: string | null; label?: string | null },
    now = new Date(),
  ): Promise<UserSessionView> {
    const db = this.personalDb();
    const expiresAt = new Date(now.getTime() + USER_SESSION_TTL_DAYS * DAY_MS);
    let row: UserSiteSession | null = input.clientRef
      ? await db.userSiteSession.findFirst({
          where: { ownerRef, clientRef: input.clientRef },
        })
      : null;
    let action: 'create' | 'update' = 'update';
    if (row && row.origin !== input.origin) {
      // Сайт записи не меняется: другой origin — другая запись.
      throw credError(
        ConflictException,
        'USER_SESSION_ORIGIN_MISMATCH',
        'У этой личной записи другой сайт',
      );
    }
    if (row) {
      row = await db.userSiteSession.update({
        where: { id: row.id },
        data: {
          ...(input.label !== undefined ? { label: input.label } : {}),
          expiresAt,
        },
      });
    } else {
      action = 'create';
      try {
        row = await db.userSiteSession.create({
          data: {
            ownerRef,
            origin: input.origin,
            registrableDomain: registrableDomain(
              new URL(input.origin).hostname,
            ),
            label: input.label ?? null,
            products: ['tutorial'],
            clientRef: input.clientRef,
            expiresAt,
          },
        });
      } catch (e) {
        if ((e as { code?: string })?.code !== 'P2002' || !input.clientRef) {
          throw e;
        }
        row = await db.userSiteSession.findFirst({
          where: { ownerRef, clientRef: input.clientRef },
        });
        if (!row) throw e;
      }
    }
    await this.audit.append(
      {
        actor: ownerRef,
        action,
        scope: 'B',
        ownerRef,
        subjectId: row.id,
        product: 'tutorial',
        result: 'ok',
      },
      now,
    );
    return this.userView(row, await this.userPurposes(row.id));
  }

  async listUserSessions(
    ownerRef: string,
    now = new Date(),
  ): Promise<UserSessionView[]> {
    const rows = await this.personalDb().userSiteSession.findMany({
      where: { ownerRef, expiresAt: { gt: now } },
      orderBy: { createdAt: 'asc' },
      include: { secrets: { select: { purpose: true, expiresAt: true } } },
    });
    return rows.map((r) => this.userView(r, this.livePurposes(r.secrets, now)));
  }

  async updateUserSession(
    ownerRef: string,
    id: string,
    input: { label: string | null },
    now = new Date(),
  ): Promise<UserSessionView> {
    const row = await this.requireUserSession(ownerRef, id, now);
    const updated = await this.personalDb().userSiteSession.update({
      where: { id: row.id },
      data: { label: input.label },
    });
    await this.audit.append(
      {
        actor: ownerRef,
        action: 'update',
        scope: 'B',
        ownerRef,
        subjectId: row.id,
        result: 'ok',
      },
      now,
    );
    return this.userView(updated, await this.userPurposes(row.id));
  }

  async putUserSecret(
    ownerRef: string,
    id: string,
    purpose: CredentialPurpose,
    plaintext: string | null,
    now = new Date(),
  ): Promise<UserSessionView> {
    const row = await this.requireUserSession(ownerRef, id, now);
    const db = this.personalDb();
    if (plaintext === null) {
      await db.userSiteSecret.deleteMany({
        where: { sessionId: row.id, purpose },
      });
      await this.audit.append(
        {
          actor: ownerRef,
          action: 'forget-secrets',
          scope: 'B',
          ownerRef,
          subjectId: row.id,
          purpose,
          result: 'ok',
        },
        now,
      );
    } else {
      const sealed = this.seal(
        plaintext,
        this.aadB(row, purpose),
        this.keyring(),
      );
      await db.userSiteSecret.upsert({
        where: { sessionId_purpose: { sessionId: row.id, purpose } },
        create: { sessionId: row.id, purpose, ...sealed },
        update: { ...sealed },
      });
      await this.audit.append(
        {
          actor: ownerRef,
          action: 'put-secret',
          scope: 'B',
          ownerRef,
          subjectId: row.id,
          purpose,
          result: 'ok',
        },
        now,
      );
    }
    // Срок личной записи — от последнего использования (как Ш0.5).
    const updated = await db.userSiteSession.update({
      where: { id: row.id },
      data: {
        expiresAt: new Date(now.getTime() + USER_SESSION_TTL_DAYS * DAY_MS),
      },
    });
    return this.userView(updated, await this.userPurposes(row.id));
  }

  /** Чтение секретов личной записи — только владельцем (`ownerRef`). */
  async readUserSecrets(
    ownerRef: string,
    id: string,
    runRef: string | null,
    now = new Date(),
  ): Promise<{ secrets: Partial<Record<CredentialPurpose, string>> }> {
    const db = this.personalDb();
    const row = await db.userSiteSession.findFirst({
      where: { id },
      include: { secrets: true },
    });
    if (!row || row.ownerRef !== ownerRef || row.expiresAt <= now) {
      await this.audit.appendQuietly(
        {
          actor: ownerRef,
          action: 'read',
          scope: 'B',
          ownerRef,
          subjectId: id,
          runRef,
          result: !row
            ? 'denied:not_found'
            : row.ownerRef !== ownerRef
              ? 'denied:owner'
              : 'denied:expired',
        },
        now,
      );
      throw credError(
        NotFoundException,
        'USER_SESSION_NOT_FOUND',
        'Личная запись не найдена или истекла',
      );
    }
    const keyring = this.keyring();
    const secrets: Partial<Record<CredentialPurpose, string>> = {};
    for (const s of row.secrets) {
      if (s.expiresAt && s.expiresAt.getTime() <= now.getTime()) continue;
      secrets[s.purpose as CredentialPurpose] = this.open(
        s,
        this.aadB(row, s.purpose as CredentialPurpose),
        keyring,
      );
    }
    await this.audit.append(
      {
        actor: ownerRef,
        action: 'read',
        scope: 'B',
        ownerRef,
        subjectId: row.id,
        product: 'tutorial',
        runRef,
        result: 'ok',
      },
      now,
    );
    await db.userSiteSession.update({
      where: { id: row.id },
      data: {
        lastUsedAt: now,
        expiresAt: new Date(now.getTime() + USER_SESSION_TTL_DAYS * DAY_MS),
      },
    });
    return { secrets };
  }

  async deleteUserSession(
    ownerRef: string,
    id: string,
    now = new Date(),
  ): Promise<{ deleted: boolean }> {
    const { count } = await this.personalDb().userSiteSession.deleteMany({
      where: { id, ownerRef },
    });
    await this.audit.append(
      {
        actor: ownerRef,
        action: 'delete',
        scope: 'B',
        ownerRef,
        subjectId: id,
        result: count === 1 ? 'ok' : 'denied:not_found',
      },
      now,
    );
    return { deleted: count === 1 };
  }

  // ── срок жизни и ротация ──────────────────────────────────────────

  /**
   * Крон `site-credentials-retention`: истёкшие учётки — секреты стёрты,
   * статус `expired`; истёкшие куки и личные записи — удалены; аренды —
   * через сутки после срока; ссылки на удалённые хосты убраны; журнал —
   * старше года.
   */
  async runRetention(now = new Date()): Promise<{
    accountsExpired: number;
    secretsExpired: number;
    userSessionsExpired: number;
    userSecretsExpired: number;
    leasesPurged: number;
    staleHostRefs: number;
    auditPurged: number;
  }> {
    const sys = this.db.system(
      'крон site-credentials-retention: сроки учёток и секретов по всем кабинетам',
    );
    const expiring = await sys.siteTestAccount.findMany({
      where: { expiresAt: { lte: now }, status: { not: 'expired' } },
      select: { id: true, accountId: true },
      take: 500,
    });
    for (const a of expiring) {
      await sys.siteCredential.deleteMany({ where: { testAccountId: a.id } });
      await sys.siteTestAccount.updateMany({
        where: { id: a.id },
        data: { status: 'expired' },
      });
      await this.audit.appendQuietly(
        {
          actor: 'cron',
          action: 'expire',
          scope: 'A',
          accountId: a.accountId,
          subjectId: a.id,
          result: 'ok',
        },
        now,
      );
    }
    const secrets = await sys.siteCredential.deleteMany({
      where: { expiresAt: { lte: now } },
    });
    const userSecrets = await sys.userSiteSecret.deleteMany({
      where: { expiresAt: { lte: now } },
    });
    const sessions = await sys.userSiteSession.findMany({
      where: { expiresAt: { lte: now } },
      select: { id: true, ownerRef: true },
      take: 500,
    });
    if (sessions.length) {
      await sys.userSiteSession.deleteMany({
        where: { id: { in: sessions.map((s) => s.id) } },
      });
      for (const s of sessions) {
        await this.audit.appendQuietly(
          {
            actor: 'cron',
            action: 'expire',
            scope: 'B',
            ownerRef: s.ownerRef,
            subjectId: s.id,
            result: 'ok',
          },
          now,
        );
      }
    }
    const leases = await sys.siteCredentialLease.deleteMany({
      where: { expiresAt: { lt: new Date(now.getTime() - DAY_MS) } },
    });
    // Хост удалён из кабинета — учётка на нём больше не действует.
    let staleHostRefs = 0;
    const withHosts = await sys.siteTestAccount.findMany({
      select: { id: true, accountId: true, hostIds: true },
      take: 2000,
      orderBy: { updatedAt: 'asc' },
    });
    const allIds = [...new Set(withHosts.flatMap((a) => a.hostIds))];
    if (allIds.length) {
      const alive = new Set(
        (
          await sys.siteHost.findMany({
            where: { id: { in: allIds } },
            select: { id: true },
          })
        ).map((h) => h.id),
      );
      for (const a of withHosts) {
        const kept = a.hostIds.filter((h) => alive.has(h));
        if (kept.length !== a.hostIds.length) {
          staleHostRefs += a.hostIds.length - kept.length;
          await sys.siteTestAccount.updateMany({
            where: { id: a.id },
            data: { hostIds: kept },
          });
        }
      }
    }
    const cutoff = new Date(now.getTime() - AUDIT_RETENTION_DAYS * DAY_MS);
    // Триггер журнала пускает DELETE только с этим флагом транзакции.
    const [, purged] = await sys.$transaction([
      sys.$executeRaw`SELECT set_config('sites.credential_audit_purge', 'on', true)`,
      sys.siteCredentialAudit.deleteMany({ where: { at: { lt: cutoff } } }),
    ]);
    return {
      accountsExpired: expiring.length,
      secretsExpired: secrets.count,
      userSessionsExpired: sessions.length,
      userSecretsExpired: userSecrets.count,
      leasesPurged: leases.count,
      staleHostRefs,
      auditPurged: purged.count,
    };
  }

  /**
   * Перешифровка строк старых версий ключа текущей (скрипт ротации).
   * `apply = false` — только счёт. Строка переписывается условием «шифротекст
   * не изменился» — параллельная запись нового секрета не затирается старым.
   */
  async rotateKeys(
    opts: { apply: boolean; batch?: number },
    now = new Date(),
  ): Promise<{
    current: string;
    scanned: number;
    rotated: number;
    failed: number;
    byVersion: Record<string, number>;
  }> {
    const keyring = this.keyring();
    const sys = this.db.system(
      'ротация ключа учётных данных: строки старых версий во всех кабинетах',
    );
    const take = opts.batch ?? 200;
    const byVersion: Record<string, number> = {};
    let scanned = 0;
    let rotated = 0;
    let failed = 0;
    const seen = new Set<string>();
    for (;;) {
      const rows = await sys.siteCredential.findMany({
        where: {
          keyVersion: { not: keyring.current },
          id: { notIn: [...seen] },
        },
        include: { testAccount: true },
        take,
      });
      if (rows.length === 0) break;
      for (const r of rows) {
        seen.add(r.id);
        scanned++;
        byVersion[r.keyVersion] = (byVersion[r.keyVersion] ?? 0) + 1;
        if (!opts.apply) continue;
        try {
          const next = resealCredential(
            r,
            this.aadA(r.testAccount, r.purpose as CredentialPurpose),
            keyring,
          );
          if (!next) continue;
          const { count } = await sys.siteCredential.updateMany({
            where: { id: r.id, ciphertext: r.ciphertext },
            data: next,
          });
          rotated += count;
        } catch {
          failed++;
        }
      }
    }
    const seenB = new Set<string>();
    for (;;) {
      const rows = await sys.userSiteSecret.findMany({
        where: {
          keyVersion: { not: keyring.current },
          id: { notIn: [...seenB] },
        },
        include: { session: true },
        take,
      });
      if (rows.length === 0) break;
      for (const r of rows) {
        seenB.add(r.id);
        scanned++;
        byVersion[r.keyVersion] = (byVersion[r.keyVersion] ?? 0) + 1;
        if (!opts.apply) continue;
        try {
          const next = resealCredential(
            r,
            this.aadB(r.session, r.purpose as CredentialPurpose),
            keyring,
          );
          if (!next) continue;
          const { count } = await sys.userSiteSecret.updateMany({
            where: { id: r.id, ciphertext: r.ciphertext },
            data: next,
          });
          rotated += count;
        } catch {
          failed++;
        }
      }
    }
    if (opts.apply) {
      await this.audit.append(
        {
          actor: 'script',
          action: 'rotate',
          scope: 'A',
          purpose: keyring.current,
          result: failed ? `ok:${rotated};failed:${failed}` : `ok:${rotated}`,
        },
        now,
      );
    }
    return { current: keyring.current, scanned, rotated, failed, byVersion };
  }

  // ── внутреннее ────────────────────────────────────────────────────

  private personalDb() {
    return this.db.system(
      'личные записи режима B: владелец — пользователь генератора, не кабинет',
    );
  }

  private aadA(
    row: Pick<SiteTestAccount, 'id' | 'accountId' | 'siteId'>,
    purpose: CredentialPurpose,
  ): CredentialAad {
    return {
      scope: 'A',
      accountId: row.accountId,
      siteId: row.siteId,
      testAccountId: row.id,
      purpose,
    };
  }

  private aadB(
    row: Pick<UserSiteSession, 'id' | 'ownerRef' | 'origin'>,
    purpose: CredentialPurpose,
  ): CredentialAad {
    return {
      scope: 'B',
      accountId: row.ownerRef,
      siteId: row.origin,
      testAccountId: row.id,
      purpose,
    };
  }

  private seal(
    plaintext: string,
    aad: CredentialAad,
    keyring: CredentialKeyring,
  ): { ciphertext: string; keyVersion: string; expiresAt: Date | null } {
    try {
      return {
        ...sealCredential(plaintext, aad, keyring),
        expiresAt: null,
      };
    } catch (e) {
      if (e instanceof CredentialCryptoError && e.code === 'too_large') {
        throw badInput(e.message);
      }
      throw e;
    }
  }

  private open(
    row: Pick<SiteCredential | UserSiteSecret, 'ciphertext' | 'keyVersion'>,
    aad: CredentialAad,
    keyring: CredentialKeyring,
  ): string {
    try {
      return openCredential(row, aad, keyring);
    } catch (e) {
      throw credError(
        ConflictException,
        'CREDENTIAL_UNREADABLE',
        'Секрет не читается: ключ удалён или запись повреждена — введите данные входа заново',
        { reason: e instanceof CredentialCryptoError ? e.code : 'error' },
      );
    }
  }

  private async writeSecret(
    row: SiteTestAccount,
    purpose: CredentialPurpose,
    plaintext: string,
    actor: string,
    keyring: CredentialKeyring,
    now = new Date(),
  ): Promise<void> {
    const sealed = this.seal(plaintext, this.aadA(row, purpose), keyring);
    const expiresAt =
      purpose === 'session-cookies'
        ? new Date(now.getTime() + COOKIES_TTL_DAYS * DAY_MS)
        : null;
    await this.db.forAccount(row.accountId).siteCredential.upsert({
      where: { testAccountId_purpose: { testAccountId: row.id, purpose } },
      create: {
        accountId: row.accountId,
        siteId: row.siteId,
        testAccountId: row.id,
        purpose,
        ciphertext: sealed.ciphertext,
        keyVersion: sealed.keyVersion,
        expiresAt,
      },
      update: {
        ciphertext: sealed.ciphertext,
        keyVersion: sealed.keyVersion,
        expiresAt,
      },
    });
    await this.audit.append(
      {
        actor,
        action: 'put-secret',
        scope: 'A',
        accountId: row.accountId,
        subjectId: row.id,
        purpose,
        result: 'ok',
      },
      now,
    );
  }

  private async requireSite(accountId: string, siteId: string): Promise<void> {
    const site = await this.db
      .forAccount(accountId)
      .site.findFirst({ where: { id: siteId }, select: { id: true } });
    if (!site) {
      throw credError(NotFoundException, 'SITE_NOT_FOUND', 'Сайт не найден');
    }
  }

  private async requireAccount(
    accountId: string,
    id: string,
    siteId: string | null,
  ): Promise<SiteTestAccount> {
    const row = await this.db.forAccount(accountId).siteTestAccount.findFirst({
      where: { id, ...(siteId ? { siteId } : {}) },
    });
    if (!row) throw notFoundAccount();
    return row;
  }

  private async requireUserSession(
    ownerRef: string,
    id: string,
    now: Date,
  ): Promise<UserSiteSession> {
    const row = await this.personalDb().userSiteSession.findFirst({
      where: { id, ownerRef },
    });
    if (!row || row.expiresAt <= now) {
      throw credError(
        NotFoundException,
        'USER_SESSION_NOT_FOUND',
        'Личная запись не найдена или истекла',
      );
    }
    return row;
  }

  /** Хосты учётки — только хосты ЭТОГО сайта ЭТОГО кабинета. */
  private async assertSiteHosts(
    accountId: string,
    siteId: string,
    hostIds: string[],
  ): Promise<void> {
    if (hostIds.length === 0) return;
    const found = await this.db.forAccount(accountId).siteHost.findMany({
      where: { id: { in: hostIds }, siteId },
      select: { id: true },
    });
    if (found.length !== hostIds.length) {
      throw badInput('хосты учётки — только хосты этого сайта');
    }
  }

  private async reload(
    accountId: string,
    id: string,
    now: Date,
  ): Promise<TestAccountView> {
    const row = await this.db.forAccount(accountId).siteTestAccount.findFirst({
      where: { id },
      include: { credentials: { select: { purpose: true, expiresAt: true } } },
    });
    if (!row) throw notFoundAccount();
    return this.view(row, row.credentials, now);
  }

  private livePurposes(
    rows: Array<{ purpose: string; expiresAt: Date | null }>,
    now: Date,
  ): string[] {
    return rows
      .filter((c) => !c.expiresAt || c.expiresAt.getTime() > now.getTime())
      .map((c) => c.purpose);
  }

  private async userPurposes(sessionId: string): Promise<string[]> {
    const rows = await this.personalDb().userSiteSecret.findMany({
      where: { sessionId },
      select: { purpose: true, expiresAt: true },
    });
    return this.livePurposes(rows, new Date());
  }

  private view(
    r: SiteTestAccount,
    creds: Array<{ purpose: string; expiresAt: Date | null }>,
    now: Date,
  ): TestAccountView {
    return {
      id: r.id,
      siteId: r.siteId,
      label: r.label,
      role: r.role,
      plan: r.plan,
      username: r.username,
      loginMethod: r.loginMethod,
      hostIds: r.hostIds,
      products: r.products,
      status: effectiveStatus(r, now),
      confirmedTestAccount: r.confirmedTestAccountAt !== null,
      createdBy: createdByKind(r.createdBy),
      secrets: secretFlags(this.livePurposes(creds, now)),
      lastUsedAt: r.lastUsedAt,
      expiresAt: r.expiresAt,
      createdAt: r.createdAt,
    };
  }

  private userView(r: UserSiteSession, purposes: string[]): UserSessionView {
    return {
      id: r.id,
      origin: r.origin,
      label: r.label,
      products: r.products,
      secrets: secretFlags(purposes),
      lastUsedAt: r.lastUsedAt,
      expiresAt: r.expiresAt,
      createdAt: r.createdAt,
    };
  }
}

export { CREDENTIAL_PURPOSES };
