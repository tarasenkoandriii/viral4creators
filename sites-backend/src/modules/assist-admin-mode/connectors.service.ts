/**
 * Коннекторы API заказчика (ТЗ §3.8 п.3–4, §5.2–§5.7): импорт OpenAPI 3.x
 * (URL или файл), автоклассификация, включение операций и роли, секреты,
 * исполнение `read` через SSRF-guard и журнал вызовов.
 *
 * Хост API (§5.5): `allowedHosts` коннектора — хост `baseUrl`; он обязан
 * быть verified-хостом сайта (`hostId`, проверяется и при КАЖДОМ вызове —
 * подтверждение могло истечь) или SaaS-аккаунтом заказчика с явной отметкой
 * владельца «это наш аккаунт в X» (`saasAcknowledged`).
 *
 * Э8: write/danger включаются (тариф Pro — «Админка: действия»), но
 * исполняются ТОЛЬКО предложением и отдельным «Да» сотрудника
 * (assist-admin-actions); здесь — настройка операции: роли, лимиты,
 * предпросмотр, компенсация (проверка как при импорте), денежный потолок,
 * слово подтверждения danger; секрет подписи изменяющих запросов.
 */
import { randomBytes } from 'crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { SitesDb } from '../../prisma/sites-db.service';
import { maskSensitiveEcho } from '../../shared/assist-chat-core';
import type { AccountMembership } from '../site-core/account/roles';
import {
  PINNED_HTTP_DEPS,
  type PinnedHttpDeps,
  pinnedFetch,
} from '../site-crawl/net/pinned-fetch';
import { AdminActionLogService } from './action-log.service';
import { adminError } from './admin-errors';
import type {
  CreateConnectorDto,
  PatchConnectorDto,
  PatchOperationDto,
  PutConnectorSecretDto,
} from './admin-mode.dto';
import { AdminModeService } from './admin-mode.service';
import {
  AdminSecretsError,
  loadAdminKeyring,
  openAdminSecret,
  sealAdminSecret,
  secretTail,
} from './admin-secrets-crypto';
import {
  type ConnectorAuth,
  type ExecResult,
  authHeaderNameAllowed,
  executeRead,
} from './connector-exec';
import {
  OPENAPI_MAX_BYTES,
  OpenApiImportError,
  type LinkedOperation,
  type OperationKind,
  type OperationParam,
  canSetKind,
  checkLinks,
  parseOpenApi,
} from './openapi-import';

export interface OperationView {
  id: string;
  operationId: string;
  method: string;
  path: string;
  summary: string | null;
  autoKind: OperationKind;
  kind: OperationKind;
  kindReason: string | null;
  enabled: boolean;
  roles: string[];
  dailyLimit: number | null;
  unsupported: boolean;
  params: OperationParam[];
  // Э8
  idempotent: boolean;
  compensation: LinkedOperation | null;
  preview: LinkedOperation | null;
  dryRunParam: string | null;
  amountParam: string | null;
  autoAmountParam: string | null;
  maxAmount: number | null;
  dailyAmountCap: number | null;
  confirmWord: string | null;
}

export interface ConnectorView {
  id: string;
  name: string;
  baseUrl: string;
  allowedHosts: string[];
  hostVerified: boolean;
  saasAcknowledged: boolean;
  specTitle: string | null;
  specVersion: string | null;
  authKind: string;
  authHeaderName: string | null;
  /** «••••1a2b» — без значения секрета (§5.6). */
  secret: { set: boolean; tail: string | null; setAt: string | null };
  status: string;
  lastCallAt: string | null;
  /** Э8: секрет подписи `X-V4C-Signature` выпущен (значение — один раз). */
  signing: { set: boolean; setAt: string | null };
  operations: OperationView[];
}

/** Строка операции → связь (`compensation`/`preview`) или null. */
export function linkOfJson(v: Prisma.JsonValue | null): LinkedOperation | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.operationId !== 'string') return null;
  const params: Record<string, string> = {};
  if (o.params && typeof o.params === 'object' && !Array.isArray(o.params)) {
    for (const [k, x] of Object.entries(o.params as Record<string, unknown>)) {
      if (typeof x === 'string') params[k] = x;
    }
  }
  return { operationId: o.operationId, params };
}

/** Доступ к коннектору для вызова (Э8: и read, и write). */
export type CallAccess =
  | {
      ok: true;
      connector: {
        id: string;
        name: string;
        baseUrl: string;
        allowedHosts: string[];
      };
      auth: ConnectorAuth;
      signSecret: string | null;
    }
  | { ok: false; outcome: 'denied' | 'blocked'; reason: string };

/** Операция, доступная модели в этом ходе (§5.4 п.1). */
export interface ToolOperation {
  rowId: string;
  connectorId: string;
  connectorName: string;
  key: string;
  operationId: string;
  method: string;
  path: string;
  summary: string | null;
  params: OperationParam[];
  dailyLimit: number | null;
}

/** Контекст вызова: кто и откуда (журнал, `X-V4C-Actor`). */
export interface CallerCtx {
  accountId: string;
  siteId: string;
  actor: string;
  actorRole: string | null;
  /** id сотрудника у заказчика (`sub`) или telegramId — для `X-V4C-Actor`. */
  actorExternal: string;
  channel: 'embed' | 'tma';
  conversationId: string | null;
}

/** Не больше 10 read-вызовов за диалог-минуту (§5.4 п.4). */
export const READS_PER_CONVERSATION_MINUTE = 10;

const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class ConnectorsService {
  private readonly logger = new Logger(ConnectorsService.name);

  constructor(
    private readonly db: SitesDb,
    private readonly mode: AdminModeService,
    private readonly log: AdminActionLogService,
    @Optional()
    @Inject(PINNED_HTTP_DEPS)
    private readonly net: Partial<PinnedHttpDeps> = {},
  ) {}

  /** Тесты: пауза перед повтором 5xx. */
  retryPauseMs = 400;

  private keyring() {
    try {
      return loadAdminKeyring(this.mode.env);
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
  }

  private opView(o: {
    id: string;
    operationId: string;
    method: string;
    path: string;
    summary: string | null;
    autoKind: string;
    kind: string;
    kindReason: string | null;
    enabled: boolean;
    roles: string[];
    dailyLimit: number | null;
    unsupported: boolean;
    params: Prisma.JsonValue;
    idempotent: boolean;
    compensation: Prisma.JsonValue | null;
    preview: Prisma.JsonValue | null;
    dryRunParam: string | null;
    amountParam: string | null;
    autoAmountParam: string | null;
    maxAmount: number | null;
    dailyAmountCap: number | null;
    confirmWord: string | null;
  }): OperationView {
    return {
      id: o.id,
      operationId: o.operationId,
      method: o.method,
      path: o.path,
      summary: o.summary,
      autoKind: o.autoKind as OperationKind,
      kind: o.kind as OperationKind,
      kindReason: o.kindReason,
      enabled: o.enabled,
      roles: o.roles,
      dailyLimit: o.dailyLimit,
      unsupported: o.unsupported,
      params: Array.isArray(o.params)
        ? (o.params as unknown as OperationParam[])
        : [],
      idempotent: o.idempotent,
      compensation: linkOfJson(o.compensation),
      preview: linkOfJson(o.preview),
      dryRunParam: o.dryRunParam,
      amountParam: o.amountParam,
      autoAmountParam: o.autoAmountParam,
      maxAmount: o.maxAmount,
      dailyAmountCap: o.dailyAmountCap,
      confirmWord: o.confirmWord,
    };
  }

  private async connectorRow(accountId: string, siteId: string, cn: string) {
    const c = await this.db
      .forAccount(accountId)
      .assistAdminConnector.findFirst({
        where: { id: cn, siteId },
        include: {
          operations: { orderBy: [{ path: 'asc' }, { method: 'asc' }] },
        },
      });
    if (!c) throw adminError(404, 'CONNECTOR_NOT_FOUND', 'Коннектор не найден');
    return c;
  }

  private async view(
    accountId: string,
    c: Awaited<ReturnType<ConnectorsService['connectorRow']>>,
  ): Promise<ConnectorView> {
    return {
      id: c.id,
      name: c.name,
      baseUrl: c.baseUrl,
      allowedHosts: c.allowedHosts,
      hostVerified: c.hostId
        ? await this.mode.hostVerified(accountId, c.hostId)
        : false,
      saasAcknowledged: c.saasAcknowledged,
      specTitle: c.specTitle,
      specVersion: c.specVersion,
      authKind: c.authKind,
      authHeaderName: c.authHeaderName,
      secret: {
        set: !!c.secretEnc,
        tail: c.secretLast4,
        setAt: c.secretSetAt?.toISOString() ?? null,
      },
      status: c.status,
      lastCallAt: c.lastCallAt?.toISOString() ?? null,
      signing: {
        set: !!c.signSecretEnc,
        setAt: c.signSetAt?.toISOString() ?? null,
      },
      operations: c.operations.map((o) => this.opView(o)),
    };
  }

  async list(m: AccountMembership, siteId: string): Promise<ConnectorView[]> {
    await this.mode.requireSite(m.accountId, siteId);
    const rows = await this.db
      .forAccount(m.accountId)
      .assistAdminConnector.findMany({
        where: { siteId },
        orderBy: { createdAt: 'asc' },
        include: {
          operations: { orderBy: [{ path: 'asc' }, { method: 'asc' }] },
        },
      });
    return Promise.all(rows.map((c) => this.view(m.accountId, c)));
  }

  async get(m: AccountMembership, siteId: string, cn: string) {
    await this.mode.requireSite(m.accountId, siteId);
    return this.view(
      m.accountId,
      await this.connectorRow(m.accountId, siteId, cn),
    );
  }

  /** Скачать спецификацию по URL (тот же IP-pin/SSRF-guard, что у вызовов). */
  private async fetchSpec(url: string): Promise<string> {
    try {
      const res = await pinnedFetch(
        url,
        {
          method: 'GET',
          headers: { accept: 'application/json' },
          maxBytes: OPENAPI_MAX_BYTES,
          timeoutMs: 10_000,
          maxRedirects: 3,
          sameOrigin: true,
        },
        this.net,
      );
      if (res.status !== 200) throw new Error(`http ${res.status}`);
      return res.body.toString('utf8');
    } catch {
      throw adminError(
        422,
        'CONNECTOR_SPEC_UNREACHABLE',
        'Не удалось скачать описание API (нужен публичный https-адрес без редиректов на другой сайт)',
      );
    }
  }

  async create(
    m: AccountMembership,
    siteId: string,
    dto: CreateConnectorDto,
  ): Promise<ConnectorView> {
    await this.mode.requireSite(m.accountId, siteId);
    if (!dto.specUrl === !dto.specText) {
      throw adminError(
        400,
        'CONNECTOR_SPEC_INVALID',
        'Укажите URL описания или файл (одно из двух)',
      );
    }
    const text = dto.specText ?? (await this.fetchSpec(dto.specUrl!));
    let spec;
    try {
      spec = parseOpenApi(text, {
        specUrl: dto.specUrl ?? null,
        baseUrlOverride: dto.baseUrl ?? null,
      });
    } catch (e) {
      if (e instanceof OpenApiImportError) {
        throw adminError(422, 'CONNECTOR_SPEC_INVALID', e.message);
      }
      throw e;
    }
    const apiHost = new URL(spec.baseUrl).hostname.toLowerCase();
    const hostId = await this.verifiedHostIdFor(m.accountId, siteId, apiHost);
    if (!hostId && dto.saasAcknowledged !== true) {
      throw adminError(
        409,
        'CONNECTOR_HOST_NOT_ALLOWED',
        `Хост API ${apiHost} не подтверждён для этого сайта. Подтвердите его как хост сайта или отметьте «это наш аккаунт в сервисе»`,
      );
    }
    const db = this.db.forAccount(m.accountId);
    const created = await db.$transaction(async (tx) => {
      const c = await tx.assistAdminConnector.create({
        data: {
          accountId: m.accountId,
          siteId,
          name: dto.name.trim(),
          baseUrl: spec.baseUrl,
          allowedHosts: [apiHost],
          hostId,
          saasAcknowledged: !hostId && dto.saasAcknowledged === true,
          specUrl: dto.specUrl ?? null,
          specHash: spec.specHash,
          specTitle: spec.title,
          specVersion: spec.version,
          createdByTelegramId: m.telegramId,
        },
      });
      await tx.assistAdminOperation.createMany({
        data: spec.operations.map((o) => ({
          accountId: m.accountId,
          siteId,
          connectorId: c.id,
          operationId: o.operationId,
          method: o.method,
          path: o.path,
          summary: o.summary,
          autoKind: o.autoKind,
          kind: o.autoKind,
          kindReason: o.kindReason,
          enabled: false,
          params: o.params as unknown as Prisma.InputJsonValue,
          unsupported: o.unsupported,
          idempotent: o.idempotent,
          compensation: (o.compensation ??
            Prisma.DbNull) as unknown as Prisma.InputJsonValue,
          preview: (o.preview ??
            Prisma.DbNull) as unknown as Prisma.InputJsonValue,
          amountParam: o.autoAmountParam,
          autoAmountParam: o.autoAmountParam,
        })),
      });
      return c;
    });
    return this.get(m, siteId, created.id);
  }

  /** id verified-хоста сайта с этим именем (L1 «Админки») или null. */
  private async verifiedHostIdFor(
    accountId: string,
    siteId: string,
    host: string,
  ): Promise<string | null> {
    const rows = await this.db.forAccount(accountId).siteHost.findMany({
      where: { siteId, host: host.toLowerCase().replace(/\.$/, '') },
      select: { id: true },
    });
    for (const r of rows) {
      if (await this.mode.hostVerified(accountId, r.id)) return r.id;
    }
    return null;
  }

  async patch(
    m: AccountMembership,
    siteId: string,
    cn: string,
    dto: PatchConnectorDto,
  ): Promise<ConnectorView> {
    await this.mode.requireSite(m.accountId, siteId);
    const c = await this.connectorRow(m.accountId, siteId, cn);
    const data: Prisma.AssistAdminConnectorUpdateManyMutationInput = {};
    if (dto.name !== undefined) data.name = dto.name.trim();
    if (dto.status !== undefined) data.status = dto.status;
    if (dto.saasAcknowledged !== undefined) {
      if (!dto.saasAcknowledged && !c.hostId) {
        // Без отметки и без подтверждённого хоста ходить некуда — пауза.
        data.status = 'paused';
      }
      data.saasAcknowledged = dto.saasAcknowledged;
    }
    await this.db
      .forAccount(m.accountId)
      .assistAdminConnector.updateMany({ where: { id: c.id }, data });
    return this.get(m, siteId, cn);
  }

  async remove(m: AccountMembership, siteId: string, cn: string) {
    await this.mode.requireSite(m.accountId, siteId);
    const c = await this.connectorRow(m.accountId, siteId, cn);
    // Секрет стирается сразу вместе со строкой (§5.6), операции — каскадом.
    await this.db
      .forAccount(m.accountId)
      .assistAdminConnector.deleteMany({ where: { id: c.id } });
    return { deleted: true };
  }

  async patchOperation(
    m: AccountMembership,
    siteId: string,
    cn: string,
    op: string,
    dto: PatchOperationDto,
  ): Promise<OperationView> {
    await this.mode.requireSite(m.accountId, siteId);
    const c = await this.connectorRow(m.accountId, siteId, cn);
    const o = c.operations.find((x) => x.id === op || x.operationId === op);
    if (!o) throw adminError(404, 'OPERATION_NOT_FOUND', 'Операция не найдена');
    const data: Prisma.AssistAdminOperationUpdateManyMutationInput = {};
    const kind = (dto.kind ?? o.kind) as OperationKind;
    const params = Array.isArray(o.params)
      ? (o.params as unknown as OperationParam[])
      : [];
    const bad = (message: string) =>
      adminError(409, 'OPERATION_CONFIG_INVALID', message);
    if (dto.kind !== undefined) {
      if (!canSetKind(o.autoKind as OperationKind, dto.kind)) {
        throw adminError(
          409,
          'OPERATION_KIND_LOWER',
          'Класс можно только поднять: изменяющую операцию нельзя объявить чтением (§5.2)',
        );
      }
      data.kind = dto.kind;
      // Поднятый класс — новое решение владельца: включить заново осознанно.
      if (dto.kind !== o.kind) data.enabled = false;
    }
    // ── Э8: предпросмотр и компенсация — та же проверка, что при импорте ──
    const preview =
      dto.preview !== undefined ? dto.preview : linkOfJson(o.preview);
    const compensation =
      dto.compensation !== undefined
        ? dto.compensation
        : linkOfJson(o.compensation);
    if (
      dto.preview !== undefined ||
      dto.compensation !== undefined ||
      dto.kind !== undefined
    ) {
      const index = new Map(c.operations.map((x) => [x.operationId, x]));
      const problem = checkLinks(
        { operationId: o.operationId, params, kind, preview, compensation },
        (id) => {
          const t = index.get(id);
          return t
            ? {
                kind: t.kind as OperationKind,
                params: Array.isArray(t.params)
                  ? (t.params as unknown as OperationParam[])
                  : [],
              }
            : null;
        },
      );
      if (problem) throw bad(`${problem.field}: ${problem.problem}`);
      if (dto.preview !== undefined) {
        data.preview = (dto.preview ??
          Prisma.DbNull) as unknown as Prisma.InputJsonValue;
      }
      if (dto.compensation !== undefined) {
        data.compensation = (dto.compensation ??
          Prisma.DbNull) as unknown as Prisma.InputJsonValue;
      }
    }
    if (dto.dryRunParam !== undefined) {
      if (
        dto.dryRunParam !== null &&
        !params.some((p) => p.name === dto.dryRunParam && p.type === 'boolean')
      ) {
        throw bad(
          'Сухой прогон: нужен булев параметр операции (dryRun/validateOnly)',
        );
      }
      data.dryRunParam = dto.dryRunParam;
    }
    const amountParam =
      dto.amountParam !== undefined ? dto.amountParam : o.amountParam;
    if (dto.amountParam !== undefined) {
      if (dto.amountParam === null && o.autoAmountParam) {
        throw bad(
          `Параметр суммы «${o.autoAmountParam}» найден автоматически — снять его нельзя, можно указать другой`,
        );
      }
      if (
        dto.amountParam !== null &&
        !params.some(
          (p) =>
            p.name === dto.amountParam &&
            p.in !== 'path' &&
            (p.type === 'number' || p.type === 'integer'),
        )
      ) {
        throw bad('Параметр суммы — числовой параметр запроса или тела');
      }
      data.amountParam = dto.amountParam;
    }
    if (dto.maxAmount !== undefined) data.maxAmount = dto.maxAmount;
    if (dto.dailyAmountCap !== undefined) {
      data.dailyAmountCap = dto.dailyAmountCap;
    }
    if (dto.confirmWord !== undefined) {
      data.confirmWord = dto.confirmWord?.trim().toUpperCase() || null;
    }
    if (dto.idempotent !== undefined) data.idempotent = dto.idempotent;
    const enabled = dto.enabled ?? (data.enabled === false ? false : o.enabled);
    if (dto.enabled === true) {
      if (o.unsupported) {
        throw adminError(
          409,
          'OPERATION_UNSUPPORTED',
          'У операции обязательный параметр в заголовке/cookie или вложенный объект в теле — помощник не сможет её вызвать',
        );
      }
      if (
        kind !== 'read' &&
        !(await this.mode.planAllowsActions(m.accountId))
      ) {
        throw adminError(
          402,
          'ADMIN_ACTIONS_PLAN',
          '«Админка: действия» (write/danger с подтверждением «Да») — в тарифе Pro',
        );
      }
    }
    if (enabled && kind !== 'read' && amountParam) {
      const max = dto.maxAmount !== undefined ? dto.maxAmount : o.maxAmount;
      const cap =
        dto.dailyAmountCap !== undefined
          ? dto.dailyAmountCap
          : o.dailyAmountCap;
      if (!max || !cap) {
        throw bad(
          `Денежная операция (параметр «${amountParam}»): задайте максимум за действие и сумму за сутки`,
        );
      }
    }
    if (dto.enabled !== undefined) data.enabled = dto.enabled;
    if (dto.roles !== undefined) data.roles = [...new Set(dto.roles)];
    if (dto.dailyLimit !== undefined) data.dailyLimit = dto.dailyLimit;
    await this.db
      .forAccount(m.accountId)
      .assistAdminOperation.updateMany({ where: { id: o.id }, data });
    const fresh = await this.db
      .forAccount(m.accountId)
      .assistAdminOperation.findFirstOrThrow({ where: { id: o.id } });
    return this.opView(fresh);
  }

  /**
   * Э8: выпустить (перевыпустить) секрет подписи изменяющих запросов
   * `X-V4C-Signature` (§5.5). Открытый текст — только в этом ответе.
   */
  async issueSigningSecret(
    m: AccountMembership,
    siteId: string,
    cn: string,
  ): Promise<{
    secret: string;
    setAt: string;
    header: string;
    format: string;
  }> {
    await this.mode.requireSite(m.accountId, siteId);
    const c = await this.connectorRow(m.accountId, siteId, cn);
    const secret = randomBytes(32).toString('base64url');
    const sealed = sealAdminSecret(
      secret,
      {
        accountId: m.accountId,
        siteId,
        ownerId: c.id,
        purpose: 'connector-signing',
      },
      this.keyring(),
    );
    const now = new Date();
    await this.db.forAccount(m.accountId).assistAdminConnector.updateMany({
      where: { id: c.id },
      data: {
        signSecretEnc: sealed.ciphertext,
        signKeyVersion: sealed.keyVersion,
        signSetAt: now,
      },
    });
    return {
      secret,
      setAt: now.toISOString(),
      header: 'X-V4C-Signature',
      format:
        't=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<METHOD>.<Idempotency-Key>.<path?query>.<body>")>',
    };
  }

  /**
   * Э8: коннектор для вызова — активен, хост годен (verified сейчас или
   * SaaS с отметкой), секрет и секрет подписи открыты (только в памяти).
   */
  async openForCall(
    accountId: string,
    siteId: string,
    connectorId: string,
  ): Promise<CallAccess> {
    const c = await this.db
      .forAccount(accountId)
      .assistAdminConnector.findFirst({ where: { id: connectorId, siteId } });
    if (!c || c.status !== 'active') {
      return { ok: false, outcome: 'denied', reason: 'connector_inactive' };
    }
    const hostOk = c.hostId
      ? await this.mode.hostVerified(accountId, c.hostId)
      : c.saasAcknowledged;
    if (!hostOk) {
      return { ok: false, outcome: 'blocked', reason: 'host_not_verified' };
    }
    let auth: ConnectorAuth = { kind: 'none' };
    let signSecret: string | null = null;
    try {
      const keyring = loadAdminKeyring(this.mode.env);
      if (c.secretEnc && c.authKind !== 'none') {
        auth = {
          kind: c.authKind as ConnectorAuth['kind'],
          headerName: c.authHeaderName,
          secret: openAdminSecret(
            { ciphertext: c.secretEnc, keyVersion: c.secretKeyVersion },
            {
              accountId,
              siteId,
              ownerId: c.id,
              purpose: 'connector-secret',
            },
            keyring,
          ),
        };
      }
      if (c.signSecretEnc) {
        signSecret = openAdminSecret(
          { ciphertext: c.signSecretEnc, keyVersion: c.signKeyVersion },
          {
            accountId,
            siteId,
            ownerId: c.id,
            purpose: 'connector-signing',
          },
          keyring,
        );
      }
    } catch (e) {
      return {
        ok: false,
        outcome: 'denied',
        reason: `secret_${e instanceof AdminSecretsError ? e.code : 'error'}`,
      };
    }
    return {
      ok: true,
      connector: {
        id: c.id,
        name: c.name,
        baseUrl: c.baseUrl,
        allowedHosts: c.allowedHosts,
      },
      auth,
      signSecret,
    };
  }

  /** 401/403 — коннектор на паузу до нового секрета (§5.7); отметка вызова. */
  async markCalled(
    accountId: string,
    connectorId: string,
    authFailed: boolean,
    now = new Date(),
  ): Promise<void> {
    await this.db.forAccount(accountId).assistAdminConnector.updateMany({
      where: { id: connectorId },
      data: {
        lastCallAt: now,
        ...(authFailed ? { status: 'auth_failed' } : {}),
      },
    });
  }

  async putSecret(
    m: AccountMembership,
    siteId: string,
    cn: string,
    dto: PutConnectorSecretDto,
  ): Promise<ConnectorView> {
    await this.mode.requireSite(m.accountId, siteId);
    const c = await this.connectorRow(m.accountId, siteId, cn);
    if (
      dto.authKind === 'header' &&
      (!dto.headerName || !authHeaderNameAllowed(dto.headerName))
    ) {
      throw adminError(
        400,
        'CONNECTOR_SPEC_INVALID',
        'Укажите имя заголовка ключа (не служебное: Host, Content-Length, Accept…)',
      );
    }
    if (dto.authKind === 'basic' && !dto.secret.includes(':')) {
      throw adminError(400, 'CONNECTOR_SPEC_INVALID', 'Basic: «логин:пароль»');
    }
    const sealed = sealAdminSecret(
      dto.secret,
      {
        accountId: m.accountId,
        siteId,
        ownerId: c.id,
        purpose: 'connector-secret',
      },
      this.keyring(),
    );
    await this.db.forAccount(m.accountId).assistAdminConnector.updateMany({
      where: { id: c.id },
      data: {
        authKind: dto.authKind,
        authHeaderName:
          dto.authKind === 'header' ? dto.headerName!.toLowerCase() : null,
        secretEnc: sealed.ciphertext,
        secretKeyVersion: sealed.keyVersion,
        secretLast4: secretTail(dto.secret) || null,
        secretSetAt: new Date(),
        // Новый секрет снимает `auth_failed` (§5.7).
        ...(c.status === 'auth_failed' ? { status: 'active' } : {}),
      },
    });
    return this.get(m, siteId, cn);
  }

  async deleteSecret(m: AccountMembership, siteId: string, cn: string) {
    await this.mode.requireSite(m.accountId, siteId);
    const c = await this.connectorRow(m.accountId, siteId, cn);
    await this.db.forAccount(m.accountId).assistAdminConnector.updateMany({
      where: { id: c.id },
      data: {
        authKind: 'none',
        authHeaderName: null,
        secretEnc: null,
        secretKeyVersion: null,
        secretLast4: null,
        secretSetAt: null,
      },
    });
    return this.get(m, siteId, cn);
  }

  // ── Исполнение (чат сотрудника) ──────────────────────────────────────

  /**
   * Операции, доступные роли в этом ходе (§5.2 слои 2–3): включённые `read`
   * активных коннекторов; `role = '*'` — владелец «Админки» (все), `null` —
   * неизвестная роль: только знания, без инструментов (§5.1).
   */
  async toolsFor(
    accountId: string,
    siteId: string,
    role: string | null,
  ): Promise<ToolOperation[]> {
    if (role === null) return [];
    const rows = await this.db
      .forAccount(accountId)
      .assistAdminOperation.findMany({
        where: {
          siteId,
          enabled: true,
          kind: 'read',
          unsupported: false,
          connector: { status: 'active' },
          ...(role === '*' ? {} : { roles: { has: role } }),
        },
        include: { connector: { select: { id: true, name: true } } },
        orderBy: [{ connectorId: 'asc' }, { operationId: 'asc' }],
        take: 40,
      });
    return rows.map((o) => ({
      rowId: o.id,
      connectorId: o.connector.id,
      connectorName: o.connector.name,
      key: `${o.connector.name}.${o.operationId}`,
      operationId: o.operationId,
      method: o.method,
      path: o.path,
      summary: o.summary,
      params: Array.isArray(o.params)
        ? (o.params as unknown as OperationParam[])
        : [],
      dailyLimit: o.dailyLimit,
    }));
  }

  private async logResult(
    ctx: CallerCtx,
    op: ToolOperation,
    r: Pick<
      ExecResult,
      | 'outcome'
      | 'httpStatus'
      | 'durationMs'
      | 'requestMasked'
      | 'responseBytes'
      | 'error'
    >,
  ) {
    try {
      await this.log.append({
        accountId: ctx.accountId,
        siteId: ctx.siteId,
        actor: ctx.actor,
        actorRole: ctx.actorRole,
        channel: ctx.channel,
        conversationId: ctx.conversationId,
        connectorId: op.connectorId,
        operationRowId: op.rowId,
        operation: op.key,
        outcome: r.outcome,
        httpStatus: r.httpStatus,
        durationMs: r.durationMs,
        requestMasked: r.requestMasked as unknown as Prisma.InputJsonValue,
        responseBytes: r.responseBytes,
        error: r.error,
      });
    } catch (e) {
      // Журнал не должен ронять ответ — но и молча пропадать тоже.
      this.logger.error(`Журнал «Админки» не записан: ${(e as Error).name}`);
    }
  }

  /**
   * Исполнить `read` (§5.4 п.4, §5.5): права и класс уже отфильтрованы
   * `toolsFor`; здесь — свежая проверка коннектора и хоста, лимиты, секрет,
   * SSRF-guard, журнал. Секрет живёт только внутри этого вызова.
   */
  async runRead(
    ctx: CallerCtx,
    op: ToolOperation,
    args: Record<string, unknown>,
    now = new Date(),
  ): Promise<ExecResult> {
    const db = this.db.forAccount(ctx.accountId);
    const deny = async (
      outcome: ExecResult['outcome'] | 'denied' | 'limit',
      error: string,
    ): Promise<ExecResult> => {
      const r = {
        outcome: outcome as ExecResult['outcome'],
        httpStatus: null,
        durationMs: 0,
        requestMasked: { method: op.method, path: op.path, query: {} },
        responseBytes: null,
        data: null,
        error,
      };
      await this.logResult(ctx, op, r);
      return r;
    };
    const access = await this.openForCall(
      ctx.accountId,
      ctx.siteId,
      op.connectorId,
    );
    if (!access.ok) return deny(access.outcome, access.reason);
    if (ctx.conversationId) {
      const recent = await db.assistAdminActionLog.count({
        where: {
          siteId: ctx.siteId,
          conversationId: ctx.conversationId,
          kind: 'read',
          at: { gte: new Date(now.getTime() - 60_000) },
        },
      });
      if (recent >= READS_PER_CONVERSATION_MINUTE) {
        return deny('limit', 'conversation_minute');
      }
    }
    if (op.dailyLimit) {
      const day = new Date(Math.floor(now.getTime() / DAY_MS) * DAY_MS);
      const used = await db.assistAdminActionLog.count({
        where: {
          siteId: ctx.siteId,
          operationRowId: op.rowId,
          kind: 'read',
          at: { gte: day },
          outcome: 'ok',
        },
      });
      if (used >= op.dailyLimit) return deny('limit', 'daily_limit');
    }
    let auth: ConnectorAuth = access.auth;
    const c = access.connector;
    const r = await executeRead(
      {
        baseUrl: c.baseUrl,
        allowedHosts: c.allowedHosts,
        method: op.method,
        path: op.path,
        params: op.params,
        args,
        auth,
        actor: ctx.actorExternal,
      },
      this.net,
      (s) => maskSensitiveEcho(s),
      this.retryPauseMs,
    );
    auth = { kind: 'none' };
    await this.logResult(ctx, op, r);
    // 401/403 — коннектор на паузу до нового секрета (§5.7).
    await this.markCalled(
      ctx.accountId,
      c.id,
      r.outcome === 'auth_failed',
      now,
    );
    return r;
  }
}
