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
 * Э7 — только чтение: включить можно лишь `read`-операцию; write/danger
 * видны в списке (класс можно поднять), но включаются в Э8 (подтверждение
 * «Да», журнал с откатом).
 */
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
  type OperationKind,
  type OperationParam,
  canSetKind,
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
  operations: OperationView[];
}

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
    if (dto.kind !== undefined) {
      if (!canSetKind(o.autoKind as OperationKind, dto.kind)) {
        throw adminError(
          409,
          'OPERATION_KIND_LOWER',
          'Класс можно только поднять: изменяющую операцию нельзя объявить чтением (§5.2)',
        );
      }
      data.kind = dto.kind;
      if (dto.kind !== 'read') data.enabled = false;
    }
    if (dto.enabled === true) {
      if (o.unsupported) {
        throw adminError(
          409,
          'OPERATION_UNSUPPORTED',
          'У операции обязательный параметр в заголовке/cookie — помощник не сможет её вызвать',
        );
      }
      if (kind !== 'read') {
        throw adminError(
          409,
          'ADMIN_ACTIONS_NEXT_STAGE',
          'Изменяющие операции (write/danger) — следующий этап: подтверждение «Да» сотрудником',
        );
      }
    }
    if (dto.enabled !== undefined && !(dto.enabled && kind !== 'read')) {
      data.enabled = dto.enabled;
    }
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
    const c = await db.assistAdminConnector.findFirst({
      where: { id: op.connectorId, siteId: ctx.siteId },
    });
    if (!c || c.status !== 'active')
      return deny('denied', 'connector_inactive');
    const hostOk = c.hostId
      ? await this.mode.hostVerified(ctx.accountId, c.hostId)
      : c.saasAcknowledged;
    if (!hostOk) return deny('blocked', 'host_not_verified');
    if (ctx.conversationId) {
      const recent = await db.assistAdminActionLog.count({
        where: {
          siteId: ctx.siteId,
          conversationId: ctx.conversationId,
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
          at: { gte: day },
          outcome: 'ok',
        },
      });
      if (used >= op.dailyLimit) return deny('limit', 'daily_limit');
    }
    let auth: ConnectorAuth = { kind: 'none' };
    if (c.secretEnc && c.authKind !== 'none') {
      try {
        auth = {
          kind: c.authKind as ConnectorAuth['kind'],
          headerName: c.authHeaderName,
          secret: openAdminSecret(
            { ciphertext: c.secretEnc, keyVersion: c.secretKeyVersion },
            {
              accountId: ctx.accountId,
              siteId: ctx.siteId,
              ownerId: c.id,
              purpose: 'connector-secret',
            },
            loadAdminKeyring(this.mode.env),
          ),
        };
      } catch (e) {
        // Код — без шифротекста и ключа.
        return deny(
          'denied',
          `secret_${e instanceof AdminSecretsError ? e.code : 'error'}`,
        );
      }
    }
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
    await db.assistAdminConnector.updateMany({
      where: { id: c.id },
      data: {
        lastCallAt: now,
        // 401/403 — коннектор на паузу до нового секрета (§5.7).
        ...(r.outcome === 'auth_failed' ? { status: 'auth_failed' } : {}),
      },
    });
    return r;
  }
}
