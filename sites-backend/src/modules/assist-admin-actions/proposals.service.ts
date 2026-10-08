/**
 * Предложения действий «Админки» и «Да» (ТЗ §5.4 п.5–7, §5.5, §5.7,
 * §4-бис.5, §5-бис.15 п.14; приёмка Э8 п.1–6).
 *
 * Поток:
 *  1. Модель (план хода) или мемо АМ-N ПРЕДЛАГАЕТ операцию write/danger с
 *     аргументами → `propose`: права роли, тариф Pro, схема OpenAPI,
 *     потолки, предпросмотр «было» (read-операция, объявленная владельцем
 *     или `x-assist-preview`), сухой прогон `native` — и строка
 *     `pending` (10 мин). В API заказчика — ни одного изменяющего запроса.
 *  2. «Да» — ОТДЕЛЬНЫЙ запрос того же сотрудника (`actor`) → `confirm`:
 *     заново роль, тариф, включённость, класс (не выше предложенного),
 *     схема, `paramsHash` (тот, что видел сотрудник, = строке = пересчёту),
 *     слово для danger, лимиты; переход `pending|unknown → executing` —
 *     условным UPDATE (двойное «Да», перезагрузка — исполнения нет, ответ —
 *     текущий статус). Исполнение — `executeWrite` (Idempotency-Key = id,
 *     без автоповтора).
 *  3. Итог — журнал (append-only, цепочка хешей), карточка, сообщение в
 *     диалоге; danger — уведомление владельцам; отказ по ключу коннектора
 *     (401 с вызовом Bearer/кодом ключа) — коннектор на паузу, 403 — нет
 *     (аудит Н-3, `ConnectorsService.markCalled`).
 *  4. Откат — ТОЛЬКО объявленная компенсация (`x-assist-compensation` или
 *     владелец), новым предложением со своим «Да»; иначе «отменить нельзя»
 *     и ручной разбор по журналу.
 */
import { randomUUID } from 'crypto';
import {
  HttpException,
  Inject,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { SitesDb } from '../../prisma/sites-db.service';
import { maskSensitiveEcho } from '../../shared/assist-chat-core';
import { AdminActionLogService } from '../assist-admin-mode/action-log.service';
import { adminError } from '../assist-admin-mode/admin-errors';
import { AdminModeService } from '../assist-admin-mode/admin-mode.service';
import {
  ParamValidationError,
  validateArgs,
} from '../assist-admin-mode/connector-exec';
import {
  type CallerCtx,
  ConnectorsService,
  type ToolOperation,
  linkOfJson,
} from '../assist-admin-mode/connectors.service';
import {
  type LinkedOperation,
  type OperationKind,
  type OperationParam,
  kindRank,
} from '../assist-admin-mode/openapi-import';
import {
  PINNED_HTTP_DEPS,
  type PinnedHttpDeps,
} from '../site-crawl/net/pinned-fetch';
import {
  ACTION_LIMITS,
  ACTION_TEXT,
  type ActionLang,
  type ProposalField,
  type ProposalStatus,
  actionTitle,
  amountOf,
  cardShowsAllArgs,
  compensationOpen,
  confirmPhraseFor,
  effectiveStatus,
  unknownRetryClosed,
  linkedArgs,
  normalizePhrase,
  proposalFields,
  proposalHash,
  requestedByEmployee,
} from './action-core';
import { executeWrite, maskBody } from './action-exec';
import { AdminActionsNotifier } from './action-notifier';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const STATE_WINDOW_MS = 8 * HOUR_MS;

/** Кто действует: сотрудник (embed/TMA) с ролью помощника и языком. */
export interface ActorCtx extends CallerCtx {
  /** `*` — владелец «Админки»; null — только знания (действий нет). */
  assistRole: string | null;
  lang: ActionLang;
}

/** Изменяющая операция, доступная роли (каталог плана и проверка «Да»). */
export interface ActionOperation extends ToolOperation {
  kind: 'write' | 'danger';
  roles: string[];
  idempotent: boolean;
  compensation: LinkedOperation | null;
  preview: LinkedOperation | null;
  dryRunParam: string | null;
  amountParam: string | null;
  maxAmount: number | null;
  dailyAmountCap: number | null;
  confirmWord: string | null;
}

export interface ProposalView {
  id: string;
  status: ProposalStatus;
  kind: 'write' | 'danger';
  operation: string;
  title: string;
  connectorName: string;
  fields: ProposalField[];
  paramsHash: string;
  unrequested: boolean;
  /** danger: набрать это слово (§5.2). */
  confirmPhrase: string | null;
  idempotent: boolean;
  /** Компенсация объявлена (иначе «отменить нельзя»). */
  undoDeclared: boolean;
  /** Можно предложить компенсацию сейчас (done, окно, параметры есть). */
  undoAvailable: boolean;
  /** Предпросмотр объявлен — «Проверить» после `unknown`. */
  checkAvailable: boolean;
  dryRun: string;
  dryRunStatus: string | null;
  dryRunNote: string | null;
  amount: number | null;
  outcome: string | null;
  httpStatus: number | null;
  errorText: string | null;
  chainStatus: string | null;
  compensationOf: string | null;
  memo: { runId: string; step: number } | null;
  attempts: number;
  expiresAt: string;
  createdAt: string;
  executedAt: string | null;
  /** Текст итога/подсказки (пишет код). */
  note: string;
}

type ProposalRow = Prisma.AssistAdminActionProposalGetPayload<object>;

type OpRow = Prisma.AssistAdminOperationGetPayload<{
  include: { connector: { select: { id: true; name: true; status: true } } };
}>;

/** Итог «Да»: карточка, текст, следующий шаг мемо (если был). */
export interface ConfirmResult {
  proposal: ProposalView;
  text: string;
  next: ProposalView | null;
}

/** Предложение или честный отказ кода (текст сотруднику). */
export type ProposeResult =
  | { ok: true; proposal: ProposalView; text: string }
  | { ok: false; code: string; text: string };

/** Подписка мемо на итог шага (регистрирует AdminMemoRunner). */
export type SettledHook = (
  ctx: ActorCtx,
  row: ProposalRow,
  status: 'done' | 'failed' | 'unknown' | 'rejected' | 'expired',
) => Promise<{ next: ProposalView | null; text: string | null }>;

function opParams(o: { params: Prisma.JsonValue }): OperationParam[] {
  return Array.isArray(o.params)
    ? (o.params as unknown as OperationParam[])
    : [];
}

function toAction(o: OpRow): ActionOperation {
  return {
    rowId: o.id,
    connectorId: o.connector.id,
    connectorName: o.connector.name,
    key: `${o.connector.name}.${o.operationId}`,
    operationId: o.operationId,
    method: o.method,
    path: o.path,
    summary: o.summary,
    params: opParams(o),
    dailyLimit: o.dailyLimit,
    kind: o.kind as 'write' | 'danger',
    roles: o.roles,
    idempotent: o.idempotent,
    compensation: linkOfJson(o.compensation),
    preview: linkOfJson(o.preview),
    dryRunParam: o.dryRunParam,
    amountParam: o.amountParam,
    maxAmount: o.maxAmount,
    dailyAmountCap: o.dailyAmountCap,
    confirmWord: o.confirmWord,
  };
}

/** Клиент для подсчёта потолков: обычный или транзакция резерва. */
type LimitDb = Pick<
  ReturnType<SitesDb['forAccount']>,
  'assistAdminActionLog' | 'assistAdminActionProposal'
>;

/**
 * Предложение, которое исполнялось (или исполняется): `executing|done|
 * unknown`, а также `expired` после «Да» (`attempts > 0`: `unknown` закрыт
 * по сроку Р-З9-21 или остановкой мемо) — исход мог примениться.
 */
const ATTEMPTED_WHERE: Prisma.AssistAdminActionProposalWhereInput[] = [
  { status: { in: ['executing', 'done', 'unknown'] } },
  { status: 'expired', attempts: { gt: 0 } },
];

function roleAllows(o: { roles: string[] }, role: string | null): boolean {
  if (role === null) return false;
  return role === '*' || o.roles.includes(role);
}

function utcDay(now: Date): Date {
  return new Date(Math.floor(now.getTime() / DAY_MS) * DAY_MS);
}

@Injectable()
export class ProposalsService {
  private readonly logger = new Logger(ProposalsService.name);
  /** Мемо АМ-N подписывается на итог шага (без циклической зависимости). */
  onSettled: SettledHook | null = null;
  /**
   * D3 (§5-бис.17 п.5 п.8): перед «Да» на шаге мемо — мемо всё ещё рабочее?
   * Нет (ушло в «требует проверки», выключено, удалено) — запуск остановлен
   * хуком, возвращается текст причины. Ставит мемо (`AdminMemoService`).
   */
  beforeMemoStep:
    | ((
        ctx: ActorCtx,
        row: ProposalRow,
      ) => Promise<{ number: number; text: string } | null>)
    | null = null;
  /** Таймаут изменяющего запроса (§5.5: 10 с); тесты — меньше. */
  execTimeoutMs = 10_000;
  /**
   * Только тесты: пауза внутри резерва «Да» (после проверки потолков, до
   * захвата) — делает гонку двух «Да» воспроизводимой (аудит Э8).
   */
  reserveHook: (() => Promise<void>) | null = null;

  constructor(
    private readonly db: SitesDb,
    private readonly mode: AdminModeService,
    private readonly connectors: ConnectorsService,
    private readonly log: AdminActionLogService,
    private readonly notifier: AdminActionsNotifier,
    @Optional()
    @Inject(PINNED_HTTP_DEPS)
    private readonly net: Partial<PinnedHttpDeps> = {},
  ) {}

  // ── каталог ────────────────────────────────────────────────────────────

  /**
   * Изменяющие операции, которые роль может ПРЕДЛОЖИТЬ в этом ходе (§5.4
   * п.1): включённые write/danger активных коннекторов, тариф Pro.
   */
  async catalog(
    accountId: string,
    siteId: string,
    role: string | null,
  ): Promise<ActionOperation[]> {
    if (role === null) return [];
    if (!(await this.mode.planAllowsActions(accountId))) return [];
    const rows = await this.db
      .forAccount(accountId)
      .assistAdminOperation.findMany({
        where: {
          siteId,
          enabled: true,
          kind: { in: ['write', 'danger'] },
          unsupported: false,
          connector: { status: 'active' },
          ...(role === '*' ? {} : { roles: { has: role } }),
        },
        include: {
          connector: { select: { id: true, name: true, status: true } },
        },
        orderBy: [{ connectorId: 'asc' }, { operationId: 'asc' }],
        take: 40,
      });
    return rows.map(toAction);
  }

  private async opRow(
    accountId: string,
    siteId: string,
    rowId: string,
  ): Promise<OpRow | null> {
    return this.db.forAccount(accountId).assistAdminOperation.findFirst({
      where: { id: rowId, siteId },
      include: {
        connector: { select: { id: true, name: true, status: true } },
      },
    });
  }

  // ── витрина ────────────────────────────────────────────────────────────

  /**
   * Карточка для сотрудника. `lang` — язык сотрудника (аудит Э8 (5): был
   * всегда uk): из контекста хода, `?lang=` маршрута или его последнего
   * вопроса (state).
   */
  view(
    r: ProposalRow,
    now = new Date(),
    op?: OpRow | null,
    lang: ActionLang = 'uk',
  ): ProposalView {
    const status = effectiveStatus(r, now);
    const fields = Array.isArray(r.fields)
      ? (r.fields as unknown as ProposalField[])
      : [];
    const comp = op ? linkOfJson(op.compensation) : null;
    const title = r.operation.split('.').slice(1).join('.') || r.operation;
    return {
      id: r.id,
      status,
      kind: r.kind as 'write' | 'danger',
      operation: r.operation,
      title: op ? actionTitle(op) : title,
      connectorName: r.operation.split('.')[0] ?? '',
      fields,
      paramsHash: r.paramsHash,
      unrequested: r.unrequested,
      confirmPhrase: r.confirmPhrase,
      idempotent: op?.idempotent ?? false,
      undoDeclared: !!comp,
      undoAvailable:
        !!comp &&
        status === 'done' &&
        r.compensationOf === null &&
        r.chainStatus !== 'compensated' &&
        // Аудит пакета C: отмена уже исполнялась с неизвестным исходом —
        // вторую не предлагаем (двойной откат), разбор — по журналу.
        r.chainStatus !== 'unknown' &&
        !!r.params &&
        compensationOpen(r.executedAt, now),
      checkAvailable: !!(op && linkOfJson(op.preview)) && !!r.params,
      dryRun: r.dryRun,
      dryRunStatus: r.dryRunStatus,
      dryRunNote: r.dryRunNote,
      amount: r.amount,
      outcome: r.outcome,
      httpStatus: r.httpStatus,
      errorText: r.errorText,
      chainStatus: r.chainStatus,
      compensationOf: r.compensationOf,
      memo:
        r.memoRunId !== null && r.memoStep !== null
          ? { runId: r.memoRunId, step: r.memoStep }
          : null,
      attempts: r.attempts,
      expiresAt: r.expiresAt.toISOString(),
      createdAt: r.createdAt.toISOString(),
      executedAt: r.executedAt?.toISOString() ?? null,
      note:
        status === 'pending' && r.unrequested
          ? ACTION_TEXT.unrequested[lang]
          : unknownRetryClosed(r, now) ||
              (r.status === 'expired' && r.outcome === 'retry_expired')
            ? ACTION_TEXT.retryExpired[lang]
            : '',
    };
  }

  private async viewWithOp(
    r: ProposalRow,
    now = new Date(),
    lang: ActionLang = 'uk',
  ) {
    return this.view(
      r,
      now,
      await this.opRow(r.accountId, r.siteId, r.operationRowId),
      lang,
    );
  }

  /** Карточки сотрудника для восстановления после перезагрузки (§4-бис.5). */
  async forState(
    accountId: string,
    siteId: string,
    actor: string,
    now = new Date(),
    lang: ActionLang = 'uk',
  ): Promise<ProposalView[]> {
    const rows = await this.db
      .forAccount(accountId)
      .assistAdminActionProposal.findMany({
        where: {
          siteId,
          actor,
          createdAt: { gte: new Date(now.getTime() - STATE_WINDOW_MS) },
        },
        orderBy: { createdAt: 'asc' },
        take: 100,
      });
    const ops = new Map<string, OpRow | null>();
    const out: ProposalView[] = [];
    for (const r of rows) {
      if (!ops.has(r.operationRowId)) {
        ops.set(
          r.operationRowId,
          await this.opRow(accountId, siteId, r.operationRowId),
        );
      }
      out.push(this.view(r, now, ops.get(r.operationRowId), lang));
    }
    return out;
  }

  /** Одна карточка сотрудника (чужая/несуществующая — 404). */
  async get(
    ctx: ActorCtx,
    id: string,
    now = new Date(),
  ): Promise<ProposalView> {
    return this.viewWithOp(await this.ownRow(ctx, id), now, ctx.lang);
  }

  private async ownRow(ctx: ActorCtx, id: string): Promise<ProposalRow> {
    const r = await this.db
      .forAccount(ctx.accountId)
      .assistAdminActionProposal.findFirst({
        where: { id, siteId: ctx.siteId, actor: ctx.actor },
      });
    if (!r) {
      throw adminError(404, 'PROPOSAL_NOT_FOUND', 'Предложение не найдено');
    }
    return r;
  }

  // ── журнал ─────────────────────────────────────────────────────────────

  private async journal(
    ctx: {
      accountId: string;
      siteId: string;
      actor: string;
      actorRole: string | null;
      channel: 'embed' | 'tma';
      conversationId: string | null;
    },
    r: {
      connectorId: string | null;
      operationRowId: string | null;
      operation: string;
    },
    e: {
      kind: 'write' | 'danger' | 'proposal' | 'decision' | 'chain';
      outcome: string;
      httpStatus?: number | null;
      durationMs?: number | null;
      request: Record<string, unknown>;
      responseBytes?: number | null;
      error?: string | null;
    },
    key?: string,
  ): Promise<void> {
    try {
      await this.log.append(
        {
          accountId: ctx.accountId,
          siteId: ctx.siteId,
          actor: ctx.actor,
          actorRole: ctx.actorRole,
          channel: ctx.channel,
          conversationId: ctx.conversationId,
          connectorId: r.connectorId,
          operationRowId: r.operationRowId,
          operation: r.operation,
          kind: e.kind,
          outcome: e.outcome,
          httpStatus: e.httpStatus ?? null,
          durationMs: e.durationMs ?? null,
          requestMasked: e.request as Prisma.InputJsonValue,
          responseBytes: e.responseBytes ?? null,
          error: e.error ?? null,
        },
        new Date(),
        key,
      );
    } catch (err) {
      this.logger.error(
        `Журнал действий «Админки» не записан: ${(err as Error).name}`,
      );
    }
  }

  private maskedArgs(
    op: { method: string; path: string; params: OperationParam[] },
    args: Record<string, unknown>,
  ) {
    try {
      const v = validateArgs(op.params, args);
      const mask = (s: string) => maskSensitiveEcho(s);
      const path = op.path.replace(/\{([^}]+)\}/g, (_m, n: string) =>
        v.path[n] !== undefined ? mask(v.path[n]) : `{${n}}`,
      );
      const query: Record<string, string> = {};
      for (const [k, x] of Object.entries(v.query)) {
        query[k] = Array.isArray(x) ? x.map(mask).join(',') : mask(x);
      }
      return {
        method: op.method,
        path,
        query,
        ...(v.body ? { body: maskBody(v.body, mask) } : {}),
      };
    } catch {
      return { method: op.method, path: op.path, query: {} };
    }
  }

  // ── потолки ────────────────────────────────────────────────────────────

  /**
   * Количественные и денежные потолки (§7.3; Э8): сайт за сутки
   * (`actionsDailyCap`), операция за сутки (`dailyLimit`), сотрудник за час,
   * сумма за действие (`maxAmount`) и за сутки по операции (`dailyAmountCap`).
   * Считаются по журналу исполнений плюс «Да», которые исполняются прямо
   * сейчас (`executing`, в журнале их ещё нет), и по суммам предложений.
   * На «Да» проверка и захват (`pending|unknown → executing`) идут под
   * advisory-блокировкой сайта в одной транзакции — атомарный резерв: два
   * параллельных «Да» потолок не перепрыгнут (аудит Э8).
   */
  private async limitProblem(
    ctx: ActorCtx,
    op: ActionOperation,
    amount: number | null,
    now: Date,
    opts: {
      q?: LimitDb;
      settings?: { actionsDailyCap: number };
      /** Само подтверждаемое предложение (повтор после unknown) — не считать. */
      excludeId?: string;
    } = {},
  ): Promise<{
    code: 'ACTION_LIMIT' | 'ACTION_AMOUNT_LIMIT';
    reason: string;
  } | null> {
    const db = opts.q ?? this.db.forAccount(ctx.accountId);
    const day = utcDay(now);
    const s =
      opts.settings ??
      (await this.mode.ensureSettings(ctx.accountId, ctx.siteId));
    const notSelf = opts.excludeId ? { id: { not: opts.excludeId } } : {};
    // «Да» в полёте: исполнение ещё не записано в журнал (зависшие — нет).
    const inFlight = (extra: Prisma.AssistAdminActionProposalWhereInput) =>
      db.assistAdminActionProposal.count({
        where: {
          siteId: ctx.siteId,
          status: 'executing',
          decidedAt: {
            gte: new Date(now.getTime() - ACTION_LIMITS.executingStaleMs),
          },
          ...notSelf,
          ...extra,
        },
      });
    const siteCount =
      (await db.assistAdminActionLog.count({
        where: {
          siteId: ctx.siteId,
          kind: { in: ['write', 'danger'] },
          at: { gte: day },
        },
      })) + (await inFlight({}));
    if (siteCount >= s.actionsDailyCap) {
      return { code: 'ACTION_LIMIT', reason: 'site_daily' };
    }
    if (op.dailyLimit) {
      const used =
        (await db.assistAdminActionLog.count({
          where: {
            siteId: ctx.siteId,
            operationRowId: op.rowId,
            kind: { in: ['write', 'danger'] },
            at: { gte: day },
          },
        })) + (await inFlight({ operationRowId: op.rowId }));
      if (used >= op.dailyLimit)
        return { code: 'ACTION_LIMIT', reason: 'op_daily' };
    }
    const hourly =
      (await db.assistAdminActionLog.count({
        where: {
          siteId: ctx.siteId,
          actor: ctx.actor,
          kind: { in: ['write', 'danger'] },
          at: { gte: new Date(now.getTime() - HOUR_MS) },
        },
      })) + (await inFlight({ actor: ctx.actor }));
    if (hourly >= ACTION_LIMITS.confirmsPerActorHour) {
      return { code: 'ACTION_LIMIT', reason: 'actor_hourly' };
    }
    if (op.amountParam) {
      if (amount === null)
        return { code: 'ACTION_AMOUNT_LIMIT', reason: 'amount_missing' };
      if (!op.maxAmount || amount > op.maxAmount) {
        return { code: 'ACTION_AMOUNT_LIMIT', reason: 'amount_max' };
      }
      const agg = await db.assistAdminActionProposal.aggregate({
        where: {
          siteId: ctx.siteId,
          operationRowId: op.rowId,
          status: { in: ['executing', 'done', 'unknown'] },
          decidedAt: { gte: day },
          ...notSelf,
        },
        _sum: { amount: true },
      });
      if (
        !op.dailyAmountCap ||
        (agg._sum.amount ?? 0) + amount > op.dailyAmountCap
      ) {
        return { code: 'ACTION_AMOUNT_LIMIT', reason: 'amount_daily' };
      }
    }
    return null;
  }

  // ── предложение ────────────────────────────────────────────────────────

  /**
   * Создать предложение (§5.4 п.5). НИ ОДНОГО изменяющего запроса к API
   * заказчика здесь нет: только чтение для «было» и — если владелец объявил
   * сухой прогон `native` — запрос с флагом dryRun. `requested` задаёт мемо и
   * компенсация (явная команда); иначе — по словам вопроса.
   */
  async propose(
    ctx: ActorCtx,
    op: ActionOperation,
    rawArgs: Record<string, unknown>,
    question: string,
    opts: {
      requested?: boolean;
      compensationOf?: string | null;
      memoRunId?: string | null;
      memoStep?: number | null;
      messageText?: boolean;
    } = {},
    now = new Date(),
  ): Promise<ProposeResult> {
    const lang = ctx.lang;
    if (!roleAllows(op, ctx.assistRole)) {
      return {
        ok: false,
        code: 'OPERATION_FORBIDDEN',
        text: ACTION_TEXT.limit[lang],
      };
    }
    if (!(await this.mode.planAllowsActions(ctx.accountId, now))) {
      return {
        ok: false,
        code: 'ADMIN_ACTIONS_PLAN',
        text: ACTION_TEXT.planNeeded[lang],
      };
    }
    let args: Record<string, unknown>;
    try {
      validateArgs(op.params, rawArgs);
      // Канонический вид: только известные параметры, как прислано.
      args = {};
      for (const p of op.params) {
        if (
          rawArgs[p.name] !== undefined &&
          rawArgs[p.name] !== null &&
          rawArgs[p.name] !== ''
        ) {
          args[p.name] = rawArgs[p.name];
        }
      }
    } catch (e) {
      return {
        ok: false,
        code: 'invalid_params',
        text: e instanceof ParamValidationError ? e.message : 'invalid',
      };
    }
    if (!cardShowsAllArgs(args)) {
      // Каждый аргумент — строка карточки; невидимых аргументов нет.
      return {
        ok: false,
        code: 'invalid_params',
        text: ACTION_TEXT.tooManyFields[lang](ACTION_LIMITS.fieldsMax),
      };
    }
    const amt = amountOf(op.amountParam, args);
    if (amt === 'missing') {
      return {
        ok: false,
        code: 'ACTION_AMOUNT_LIMIT',
        text: ACTION_TEXT.amountMissing[lang],
      };
    }
    const db = this.db.forAccount(ctx.accountId);
    const pending = await db.assistAdminActionProposal.count({
      where: {
        siteId: ctx.siteId,
        actor: ctx.actor,
        status: 'pending',
        expiresAt: { gt: now },
      },
    });
    if (pending >= ACTION_LIMITS.pendingPerActor) {
      return {
        ok: false,
        code: 'ACTION_LIMIT',
        text: ACTION_TEXT.pendingMany[lang],
      };
    }
    const lim = await this.limitProblem(ctx, op, amt, now);
    if (lim) {
      return {
        ok: false,
        code: lim.code,
        text:
          lim.code === 'ACTION_AMOUNT_LIMIT'
            ? ACTION_TEXT.amountLimit[lang]
            : ACTION_TEXT.limit[lang],
      };
    }
    const id = randomUUID();
    // Предпросмотр «было» (§5.5 `preview`): read-операция того же коннектора.
    let preview: unknown = undefined;
    const dryRun: string[] = [];
    let dryRunStatus: string | null = null;
    let dryRunNote: string | null = null;
    if (op.preview) {
      dryRun.push('preview');
      const pargs = linkedArgs(op.preview, args, null);
      const pop = pargs
        ? await this.readOp(
            ctx.accountId,
            ctx.siteId,
            op.connectorId,
            op.preview.operationId,
            ctx.assistRole,
          )
        : null;
      if (pargs && pop) {
        const r = await this.connectors.runRead(ctx, pop, pargs, now);
        if (r.outcome === 'ok' && r.data) {
          try {
            preview = JSON.parse(r.data) as unknown;
          } catch {
            preview = undefined;
          }
        }
      }
      dryRunStatus = preview === undefined ? 'failed' : 'ok';
    }
    // Сухой прогон `native` (§5.5): владелец объявил булев параметр dryRun.
    if (op.dryRunParam) {
      dryRun.push('native');
      const access = await this.connectors.openForCall(
        ctx.accountId,
        ctx.siteId,
        op.connectorId,
      );
      if (access.ok) {
        const r = await executeWrite(
          {
            baseUrl: access.connector.baseUrl,
            allowedHosts: access.connector.allowedHosts,
            method: op.method,
            path: op.path,
            params: op.params,
            args: { ...args, [op.dryRunParam]: true },
            auth: access.auth,
            actor: ctx.actorExternal,
            idempotencyKey: `${id}:dry`,
            signSecret: access.signSecret,
            nowSec: now.getTime() / 1000,
            timeoutMs: this.execTimeoutMs,
          },
          this.net,
          (s) => maskSensitiveEcho(s),
        );
        dryRunStatus =
          r.status === 'done' && dryRunStatus !== 'failed' ? 'ok' : 'failed';
        dryRunNote = r.status === 'done' ? null : (r.errorText ?? r.error);
        await this.journal(
          ctx,
          {
            connectorId: op.connectorId,
            operationRowId: op.rowId,
            operation: op.key,
          },
          {
            kind: 'proposal',
            outcome: `dry_run_${r.outcome}`,
            httpStatus: r.httpStatus,
            durationMs: r.durationMs,
            request: r.requestMasked,
            responseBytes: r.responseBytes,
            error: r.error,
          },
        );
      } else {
        dryRunStatus = 'failed';
        dryRunNote = access.reason;
      }
    }
    if (preview !== undefined) {
      const text = JSON.stringify(preview);
      if (Buffer.byteLength(text, 'utf8') > ACTION_LIMITS.previewMaxBytes) {
        preview = undefined;
        dryRunStatus = 'failed';
      }
    }
    const requested = opts.requested ?? requestedByEmployee(question, op.kind);
    const fields = proposalFields(op.params, args, preview);
    const row = await db.assistAdminActionProposal.create({
      data: {
        id,
        accountId: ctx.accountId,
        siteId: ctx.siteId,
        conversationId: ctx.conversationId,
        channel: ctx.channel,
        actor: ctx.actor,
        actorExternal: ctx.actorExternal,
        actorRole: ctx.actorRole,
        assistRole: ctx.assistRole ?? '',
        connectorId: op.connectorId,
        operationRowId: op.rowId,
        operation: op.key,
        kind: op.kind,
        params: args as Prisma.InputJsonValue,
        paramsHash: proposalHash(op.rowId, args),
        fields: fields as unknown as Prisma.InputJsonValue,
        preview:
          preview === undefined
            ? Prisma.DbNull
            : (preview as Prisma.InputJsonValue),
        dryRun: dryRun.length ? dryRun.join('+') : 'none',
        dryRunStatus,
        dryRunNote: dryRunNote?.slice(0, 300) ?? null,
        unrequested: !requested,
        confirmPhrase:
          op.kind === 'danger'
            ? confirmPhraseFor(op.confirmWord, lang, args)
            : null,
        amount: typeof amt === 'number' ? amt : null,
        compensationOf: opts.compensationOf ?? null,
        memoRunId: opts.memoRunId ?? null,
        memoStep: opts.memoStep ?? null,
        expiresAt: new Date(now.getTime() + ACTION_LIMITS.proposalTtlMs),
        createdAt: now,
      },
    });
    await this.journal(
      ctx,
      {
        connectorId: op.connectorId,
        operationRowId: op.rowId,
        operation: op.key,
      },
      {
        kind: 'proposal',
        outcome: 'pending',
        request: { ...this.maskedArgs(op, args), proposal: id },
        error: row.unrequested ? 'unrequested' : null,
      },
    );
    const proposal = this.view(
      row,
      now,
      await this.opRow(ctx.accountId, ctx.siteId, op.rowId),
      ctx.lang,
    );
    const what = `${actionTitle(op)}${
      fields.length
        ? ` (${fields
            .map(
              (f) =>
                `${f.name}: ${Array.isArray(f.after) ? f.after.join(', ') : f.after}`,
            )
            .join('; ')
            .slice(0, 300)})`
        : ''
    }`;
    return {
      ok: true,
      proposal,
      text: `${ACTION_TEXT.proposed[lang](what)}${row.unrequested ? `\n\n${ACTION_TEXT.unrequested[lang]}` : ''}${op.kind === 'danger' && !op.compensation ? `\n\n${ACTION_TEXT.noUndo[lang]}` : ''}`,
    };
  }

  /**
   * read-операция коннектора по operationId — для предпросмотра и
   * «Проверить». Только включённая и доступная роли (аудит Э8: ссылка
   * `preview` не открывает сотруднику чтение, которое владелец выключил
   * или не дал его роли — «было» тогда не показывается).
   */
  private async readOp(
    accountId: string,
    siteId: string,
    connectorId: string,
    operationId: string,
    role: string | null,
  ): Promise<ToolOperation | null> {
    if (role === null) return null;
    const o = await this.db
      .forAccount(accountId)
      .assistAdminOperation.findFirst({
        where: {
          siteId,
          connectorId,
          operationId,
          kind: 'read',
          enabled: true,
          unsupported: false,
          ...(role === '*' ? {} : { roles: { has: role } }),
        },
        include: { connector: { select: { id: true, name: true } } },
      });
    if (!o) return null;
    return {
      rowId: o.id,
      connectorId: o.connector.id,
      connectorName: o.connector.name,
      key: `${o.connector.name}.${o.operationId}`,
      operationId: o.operationId,
      method: o.method,
      path: o.path,
      summary: o.summary,
      params: opParams(o),
      dailyLimit: o.dailyLimit,
    };
  }

  // ── «Да» ───────────────────────────────────────────────────────────────

  async confirm(
    ctx: ActorCtx,
    id: string,
    body: {
      paramsHash: string;
      phrase?: string | null;
      acknowledgeRisk?: boolean;
    },
    now = new Date(),
  ): Promise<ConfirmResult> {
    const db = this.db.forAccount(ctx.accountId);
    let row = await this.ownRow(ctx, id);
    const lang = ctx.lang;
    let eff = effectiveStatus(row, now);
    if (row.status === 'executing' && eff === 'unknown') {
      // Зависшее исполнение (процесс умер): честно «не знаю», повтор — «Да».
      await db.assistAdminActionProposal.updateMany({
        where: { id: row.id, status: 'executing' },
        data: { status: 'unknown', outcome: 'stale' },
      });
      row = await this.ownRow(ctx, id);
      eff = effectiveStatus(row, now);
    }
    if (eff === 'expired' && unknownRetryClosed(row, now)) {
      // Р-З9-21: `unknown` старше суток — повтор тем же ключом закрыт
      // (API вправе забыть ключ идемпотентности, повтор стал бы дублем).
      const w = await db.assistAdminActionProposal.updateMany({
        where: { id: row.id, status: 'unknown' },
        data: { status: 'expired', outcome: 'retry_expired' },
      });
      if (w.count === 1) {
        await this.journal(
          ctx,
          {
            connectorId: row.connectorId,
            operationRowId: row.operationRowId,
            operation: row.operation,
          },
          {
            kind: 'decision',
            outcome: 'retry_expired',
            request: { proposal: row.id },
          },
        );
        // Закрытая по сроку КОМПЕНСАЦИЯ: исход отката неизвестен — цепочка
        // исходного действия `unknown` новой записью (вторую отмену код не
        // предложит; аудит пакета C).
        if (row.compensationOf) {
          const orig = await db.assistAdminActionProposal.findFirst({
            where: { id: row.compensationOf, siteId: ctx.siteId },
          });
          if (orig && orig.chainStatus !== 'compensated') {
            await db.assistAdminActionProposal.updateMany({
              where: { id: orig.id },
              data: { chainStatus: 'unknown' },
            });
            await this.journal(
              ctx,
              {
                connectorId: orig.connectorId,
                operationRowId: orig.operationRowId,
                operation: orig.operation,
              },
              {
                kind: 'chain',
                outcome: 'unknown',
                request: { proposal: orig.id, compensation: row.id },
              },
            );
          }
        }
      }
      throw adminError(
        410,
        'PROPOSAL_RETRY_EXPIRED',
        ACTION_TEXT.retryExpired[lang],
      );
    }
    if (eff === 'expired') {
      if (row.status === 'pending') {
        await db.assistAdminActionProposal.updateMany({
          where: { id: row.id, status: 'pending' },
          data: { status: 'expired' },
        });
        await this.settle(ctx, row, 'expired');
      }
      throw adminError(
        410,
        'PROPOSAL_EXPIRED',
        'Предложение устарело — повторите команду',
      );
    }
    if (eff === 'rejected') {
      throw adminError(409, 'PROPOSAL_DECIDED', 'Предложение уже отклонено');
    }
    if (eff === 'done' || eff === 'failed' || eff === 'executing') {
      // Повторное «Да» (перезагрузка, двойной клик) — тот же результат по id.
      return {
        proposal: await this.viewWithOp(row, now, ctx.lang),
        text: '',
        next: null,
      };
    }
    // D3: шаг мемо исполняется только у рабочего мемо — предложение,
    // сделанное до «требует проверки»/выключения, гасится с причиной.
    if (row.memoRunId && this.beforeMemoStep) {
      const halted = await this.beforeMemoStep(ctx, row);
      if (halted) {
        // Ожидавший «Да» шаг — `rejected`; шаг после `unknown` (исполнялся,
        // исход неизвестен) — `expired`: триггер неизменности запрещает
        // `unknown → rejected` (было 500 вместо 409 MEMO_HALTED).
        await db.assistAdminActionProposal.updateMany({
          where: { id: row.id, status: 'pending' },
          data: { status: 'rejected', outcome: 'memo_halted' },
        });
        await db.assistAdminActionProposal.updateMany({
          where: { id: row.id, status: 'unknown' },
          data: { status: 'expired', outcome: 'memo_halted' },
        });
        throw adminError(409, 'MEMO_HALTED', halted.text);
      }
    }
    // pending | unknown — проверки заново (§5.4 п.6).
    if (
      typeof body.paramsHash !== 'string' ||
      body.paramsHash !== row.paramsHash
    ) {
      throw adminError(
        409,
        'PROPOSAL_CHANGED',
        'Параметры изменились после предложения — «Да» не принято',
      );
    }
    const params =
      row.params && typeof row.params === 'object' && !Array.isArray(row.params)
        ? (row.params as Record<string, unknown>)
        : null;
    if (
      !params ||
      proposalHash(row.operationRowId, params) !== row.paramsHash
    ) {
      throw adminError(
        409,
        'PROPOSAL_CHANGED',
        'Параметры изменились после предложения — «Да» не принято',
      );
    }
    const o = await this.opRow(ctx.accountId, ctx.siteId, row.operationRowId);
    if (
      !o ||
      !o.enabled ||
      o.unsupported ||
      (o.kind !== 'write' && o.kind !== 'danger') ||
      o.connector.status !== 'active' ||
      !roleAllows(o, ctx.assistRole)
    ) {
      throw adminError(
        403,
        'OPERATION_FORBIDDEN',
        'Операция сейчас недоступна вашей роли',
      );
    }
    if (
      kindRank(o.kind as OperationKind) > kindRank(row.kind as OperationKind)
    ) {
      throw adminError(
        409,
        'PROPOSAL_CHANGED',
        'Класс операции повышен — повторите команду',
      );
    }
    const op = toAction(o);
    try {
      validateArgs(op.params, params);
    } catch {
      throw adminError(
        409,
        'PROPOSAL_CHANGED',
        'Схема операции изменилась — повторите команду',
      );
    }
    if (!(await this.mode.planAllowsActions(ctx.accountId, now))) {
      throw adminError(
        402,
        'ADMIN_ACTIONS_PLAN',
        '«Админка: действия» — в тарифе Pro',
      );
    }
    if (row.kind === 'danger' || o.kind === 'danger') {
      const expected =
        row.confirmPhrase ?? confirmPhraseFor(op.confirmWord, lang, params);
      if (normalizePhrase(body.phrase ?? '') !== expected) {
        throw adminError(
          422,
          'PROPOSAL_PHRASE',
          `Наберите «${expected}», чтобы подтвердить`,
        );
      }
    }
    if (
      row.status === 'unknown' &&
      !op.idempotent &&
      body.acknowledgeRisk !== true
    ) {
      throw adminError(
        409,
        'PROPOSAL_RISK_ACK',
        'API не обещает защиту от дубля: сначала проверьте результат в админке, затем подтвердите повтор',
      );
    }
    const access = await this.connectors.openForCall(
      ctx.accountId,
      ctx.siteId,
      op.connectorId,
    );
    if (!access.ok) {
      throw adminError(
        409,
        'ACTION_UNAVAILABLE',
        'Система сейчас недоступна помощнику — действие не выполнено',
      );
    }
    const settings = await this.mode.ensureSettings(ctx.accountId, ctx.siteId);
    // Атомарный резерв (аудит Э8): потолки, единственность компенсации и
    // условный переход — под блокировкой сайта в одной транзакции; второй
    // параллельный «Да» видит первый уже в `executing`.
    const claim = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`assist-admin-actions:${ctx.siteId}`}))`;
      const lim = await this.limitProblem(ctx, op, row.amount, now, {
        q: tx,
        settings,
        excludeId: row.id,
      });
      if (lim) return { lim, count: 0 };
      if (this.reserveHook) await this.reserveHook();
      if (row.compensationOf) {
        // Компенсация исполняется один раз: другая компенсация того же
        // действия уже в полёте или исполнена — эта не исполняется.
        const other = await tx.assistAdminActionProposal.count({
          where: {
            siteId: ctx.siteId,
            compensationOf: row.compensationOf,
            id: { not: row.id },
            OR: ATTEMPTED_WHERE,
          },
        });
        if (other > 0) return { lim: null, count: -1 };
      }
      // Условный переход: исполнит ровно один «Да» (§4-бис.5).
      const c = await tx.assistAdminActionProposal.updateMany({
        where: { id: row.id, status: row.status },
        data: {
          status: 'executing',
          decidedBy: ctx.actor,
          decidedAt: now,
          attempts: { increment: 1 },
        },
      });
      return { lim: null, count: c.count };
    });
    if (claim.lim) {
      throw adminError(
        429,
        claim.lim.code,
        claim.lim.code === 'ACTION_AMOUNT_LIMIT'
          ? 'Сумма выше лимита владельца'
          : 'Лимит действий исчерпан',
      );
    }
    if (claim.count === -1) {
      throw adminError(
        409,
        'COMPENSATION_UNAVAILABLE',
        'Это действие уже компенсируется другой карточкой',
      );
    }
    if (claim.count === 0) {
      return {
        proposal: await this.viewWithOp(
          await this.ownRow(ctx, id),
          now,
          ctx.lang,
        ),
        text: '',
        next: null,
      };
    }
    const attempt = row.attempts + 1;
    const r = await executeWrite(
      {
        baseUrl: access.connector.baseUrl,
        allowedHosts: access.connector.allowedHosts,
        method: op.method,
        path: op.path,
        params: op.params,
        args: params,
        auth: access.auth,
        actor: ctx.actorExternal,
        idempotencyKey: row.id,
        signSecret: access.signSecret,
        nowSec: now.getTime() / 1000,
        timeoutMs: this.execTimeoutMs,
      },
      this.net,
      (s) => maskSensitiveEcho(s),
    );
    const finalStatus = r.status;
    await db.assistAdminActionProposal.updateMany({
      where: { id: row.id, status: 'executing' },
      data: {
        status: finalStatus,
        outcome: r.outcome,
        httpStatus: r.httpStatus,
        errorText: r.errorText,
        executedAt: new Date(),
        chainStatus:
          finalStatus === 'done'
            ? 'committed'
            : finalStatus === 'unknown'
              ? 'unknown'
              : null,
      },
    });
    await this.journal(
      ctx,
      {
        connectorId: op.connectorId,
        operationRowId: op.rowId,
        operation: op.key,
      },
      {
        kind: row.kind as 'write' | 'danger',
        outcome: r.outcome,
        httpStatus: r.httpStatus,
        durationMs: r.durationMs,
        request: { ...r.requestMasked, proposal: row.id, attempt },
        responseBytes: r.responseBytes,
        error: r.error,
      },
      `exec:${row.id}:${attempt}`,
    );
    // Пауза коннектора — только отказ по ключу (аудит Н-3): 403 и одиночный
    // неясный 401 — отказ по сотруднику, коннектор исправен.
    const paused = await this.connectors.markCalled(
      ctx.accountId,
      op.connectorId,
      r.authReject,
    );
    const keyRejected = paused || r.outcome === 'auth_failed';
    if (paused) {
      await this.notifier.authFailed({
        accountId: ctx.accountId,
        siteId: ctx.siteId,
        connector: op.connectorName,
      });
    }
    if (row.kind === 'danger') {
      const s = await this.mode.ensureSettings(ctx.accountId, ctx.siteId);
      if (s.notifyDanger) {
        await this.notifier.dangerExecuted({
          accountId: ctx.accountId,
          siteId: ctx.siteId,
          operation: op.key,
          title: actionTitle(op),
          actor: ctx.actor,
          status: finalStatus,
          items: Object.values(params).reduce<number>(
            (n, v) => (Array.isArray(v) ? Math.max(n, v.length) : n),
            1,
          ),
        });
      }
    }
    // Компенсация — статус цепочки исходного действия новой записью (§5-бис.15 п.11).
    if (row.compensationOf) {
      const chain =
        finalStatus === 'done'
          ? 'compensated'
          : finalStatus === 'unknown'
            ? 'unknown'
            : 'compensation_failed';
      const orig = await db.assistAdminActionProposal.findFirst({
        where: { id: row.compensationOf, siteId: ctx.siteId },
      });
      if (orig) {
        await db.assistAdminActionProposal.updateMany({
          where: { id: orig.id },
          data: { chainStatus: chain },
        });
        await this.journal(
          ctx,
          {
            connectorId: orig.connectorId,
            operationRowId: orig.operationRowId,
            operation: orig.operation,
          },
          {
            kind: 'chain',
            outcome: chain,
            request: { proposal: orig.id, compensation: row.id },
          },
        );
      }
    }
    const fresh = await this.ownRow(ctx, id);
    const what = actionTitle(op);
    const text =
      finalStatus === 'done'
        ? ACTION_TEXT.done[lang](what)
        : keyRejected
          ? ACTION_TEXT.authFailed[lang](op.connectorName)
          : finalStatus === 'failed'
            ? ACTION_TEXT.failed[lang](what, r.errorText)
            : ACTION_TEXT.unknown[lang](what);
    const settled = await this.settle(ctx, fresh, finalStatus);
    await this.chatNote(
      ctx,
      fresh,
      settled.text ? `${text}\n\n${settled.text}` : text,
      now,
    );
    return {
      proposal: await this.viewWithOp(fresh, now, ctx.lang),
      text: settled.text ? `${text}\n\n${settled.text}` : text,
      next: settled.next,
    };
  }

  private async settle(
    ctx: ActorCtx,
    row: ProposalRow,
    status: 'done' | 'failed' | 'unknown' | 'rejected' | 'expired',
  ): Promise<{ next: ProposalView | null; text: string | null }> {
    if (!row.memoRunId || !this.onSettled) return { next: null, text: null };
    try {
      return await this.onSettled(ctx, row, status);
    } catch (e) {
      if (e instanceof HttpException) throw e;
      this.logger.error(`Мемо: шаг не продолжен: ${(e as Error).name}`);
      return { next: null, text: null };
    }
  }

  /** Итог — сообщением в диалог сотрудника (история после перезагрузки). */
  private async chatNote(
    ctx: ActorCtx,
    row: ProposalRow,
    text: string,
    now: Date,
  ) {
    if (!row.conversationId) return;
    const db = this.db.forAccount(ctx.accountId);
    await db.assistAdminMessage.create({
      data: {
        accountId: ctx.accountId,
        siteId: ctx.siteId,
        conversationId: row.conversationId,
        role: 'assistant',
        text: text.slice(0, 4000),
        flags: [`action_${row.status}`],
        answerPath: 'action',
        proposalId: row.id,
        createdAt: new Date(Math.max(now.getTime(), Date.now())),
      },
    });
    await db.assistAdminConversation.updateMany({
      where: { id: row.conversationId },
      data: { lastActivityAt: now, stateVersion: { increment: 1 } },
    });
  }

  // ── «Нет» ──────────────────────────────────────────────────────────────

  async reject(
    ctx: ActorCtx,
    id: string,
    now = new Date(),
  ): Promise<ConfirmResult> {
    const row = await this.ownRow(ctx, id);
    const db = this.db.forAccount(ctx.accountId);
    const done = await db.assistAdminActionProposal.updateMany({
      where: { id: row.id, status: 'pending' },
      data: { status: 'rejected', decidedBy: ctx.actor, decidedAt: now },
    });
    if (done.count === 0) {
      return {
        proposal: await this.viewWithOp(row, now, ctx.lang),
        text: '',
        next: null,
      };
    }
    await this.journal(
      ctx,
      {
        connectorId: row.connectorId,
        operationRowId: row.operationRowId,
        operation: row.operation,
      },
      { kind: 'decision', outcome: 'rejected', request: { proposal: row.id } },
    );
    const fresh = await this.ownRow(ctx, id);
    const settled = await this.settle(ctx, fresh, 'rejected');
    const text =
      ACTION_TEXT.rejected[ctx.lang] +
      (settled.text ? `\n\n${settled.text}` : '');
    await this.chatNote(ctx, fresh, text, now);
    return {
      proposal: await this.viewWithOp(fresh, now, ctx.lang),
      text,
      next: null,
    };
  }

  // ── «Проверить» (после unknown) ────────────────────────────────────────

  /**
   * Текущее состояние сущности read-операцией предпросмотра (§5.7: «не знаю,
   * применилось ли» + «проверить»). Ничего не меняет.
   */
  async check(
    ctx: ActorCtx,
    id: string,
    now = new Date(),
  ): Promise<{
    available: boolean;
    fields: Array<{
      name: string;
      now: string | string[] | null;
      expected: string | string[];
    }>;
  }> {
    const row = await this.ownRow(ctx, id);
    const o = await this.opRow(ctx.accountId, ctx.siteId, row.operationRowId);
    const link = o ? linkOfJson(o.preview) : null;
    const params = row.params as Record<string, unknown> | null;
    if (!o || !link || !params) return { available: false, fields: [] };
    const pargs = linkedArgs(link, params, null);
    const rop = pargs
      ? await this.readOp(
          ctx.accountId,
          ctx.siteId,
          o.connectorId,
          link.operationId,
          ctx.assistRole,
        )
      : null;
    if (!pargs || !rop) return { available: false, fields: [] };
    const r = await this.connectors.runRead(ctx, rop, pargs, now);
    if (r.outcome !== 'ok' || !r.data) return { available: false, fields: [] };
    let snap: unknown;
    try {
      snap = JSON.parse(r.data);
    } catch {
      return { available: false, fields: [] };
    }
    const f = proposalFields(opParams(o), params, snap);
    return {
      available: true,
      fields: f
        .filter((x) => x.in !== 'path')
        .map((x) => ({
          name: x.name,
          now: x.before ?? null,
          expected: x.after,
        })),
    };
  }

  // ── компенсация ────────────────────────────────────────────────────────

  /**
   * Предложить компенсацию исполненного действия (§5-бис.15 п.14): ТОЛЬКО
   * объявленная операция (`x-assist-compensation`/владелец), класс не ниже,
   * параметры — из исходного запроса/снимка «было»; это НОВОЕ предложение со
   * своим «Да». `anyActor` — владелец из журнала TMA (сотрудник — только своё).
   */
  async compensate(
    ctx: ActorCtx,
    id: string,
    opts: { anyActor?: boolean } = {},
    now = new Date(),
  ): Promise<ProposeResult> {
    const db = this.db.forAccount(ctx.accountId);
    const row = opts.anyActor
      ? await db.assistAdminActionProposal.findFirst({
          where: { id, siteId: ctx.siteId },
        })
      : await this.ownRow(ctx, id);
    if (!row)
      throw adminError(404, 'PROPOSAL_NOT_FOUND', 'Предложение не найдено');
    const unavailable = (msg: string) =>
      adminError(409, 'COMPENSATION_UNAVAILABLE', msg);
    if (row.status !== 'done')
      throw unavailable('Отменять нечего: действие не исполнено');
    // Компенсацию не компенсируют (аудит Э8): иначе «откат отката» по
    // самоссылающейся операции (статус ↔ статус, возврат ↔ списание)
    // бесконечен; ошибку компенсации разбирают вручную по журналу.
    if (row.compensationOf)
      throw unavailable(
        'Это уже компенсация — повторный откат только вручную по журналу',
      );
    if (row.chainStatus === 'compensated')
      throw unavailable('Уже компенсировано');
    if (!compensationOpen(row.executedAt, now) || !row.params) {
      throw unavailable(
        'Окно компенсации закрыто — разберите вручную по журналу',
      );
    }
    const o = await this.opRow(ctx.accountId, ctx.siteId, row.operationRowId);
    const link = o ? linkOfJson(o.compensation) : null;
    if (!o || !link) {
      throw unavailable(
        'Компенсация не объявлена — отменить можно только вручную по журналу',
      );
    }
    if (row.chainStatus === 'unknown') {
      throw unavailable(
        'Отмена уже исполнялась, исход неизвестен — проверьте в админке и разберите по журналу',
      );
    }
    // Аудит пакета C (P1): компенсация, исполнявшаяся с неизвестным исходом
    // и закрытая по сроку (`expired` после «Да», Р-З9-21), — тоже «была»:
    // вторую не создаём (иначе двойной откат).
    const tried = await db.assistAdminActionProposal.findFirst({
      where: {
        siteId: ctx.siteId,
        compensationOf: row.id,
        status: 'expired',
        attempts: { gt: 0 },
      },
      select: { id: true },
    });
    if (tried) {
      throw unavailable(
        'Отмена уже исполнялась, исход неизвестен — проверьте в админке и разберите по журналу',
      );
    }
    const existing = await db.assistAdminActionProposal.findFirst({
      where: {
        siteId: ctx.siteId,
        compensationOf: row.id,
        status: { in: ['pending', 'executing', 'unknown'] },
      },
    });
    // `unknown` компенсации — всегда «в полёте» (и после суток Р-З9-21:
    // исход неизвестен, вторую компенсацию не предлагаем).
    if (
      existing &&
      (existing.status === 'unknown' ||
        effectiveStatus(existing, now) !== 'expired')
    ) {
      return {
        ok: true,
        proposal: await this.viewWithOp(existing, now, ctx.lang),
        text: '',
      };
    }
    const target = await db.assistAdminOperation.findFirst({
      where: {
        siteId: ctx.siteId,
        connectorId: o.connectorId,
        operationId: link.operationId,
      },
      include: {
        connector: { select: { id: true, name: true, status: true } },
      },
    });
    if (!target || (target.kind !== 'write' && target.kind !== 'danger')) {
      throw unavailable('Компенсирующая операция не найдена');
    }
    if (
      kindRank(target.kind as OperationKind) <
      kindRank(row.kind as OperationKind)
    ) {
      throw unavailable(
        'Компенсирующая операция ниже классом — не предлагается',
      );
    }
    if (
      !target.enabled ||
      target.connector.status !== 'active' ||
      !roleAllows(target, ctx.assistRole)
    ) {
      throw unavailable(
        'Компенсирующая операция выключена или недоступна вашей роли',
      );
    }
    const args = linkedArgs(
      link,
      row.params as Record<string, unknown>,
      row.preview,
    );
    if (!args)
      throw unavailable('Нет значений для компенсации (нет снимка «было»)');
    return this.propose(
      ctx,
      toAction(target),
      args,
      '',
      { requested: true, compensationOf: row.id },
      now,
    );
  }

  /** Владелец (TMA): действия сайта для журнала с откатом. */
  async listForOwner(
    accountId: string,
    siteId: string,
    q: { chain?: 'review' | null; limit?: number; lang?: ActionLang },
    now = new Date(),
  ): Promise<Array<ProposalView & { actor: string; channel: string }>> {
    const rows = await this.db
      .forAccount(accountId)
      .assistAdminActionProposal.findMany({
        where: {
          siteId,
          ...(q.chain === 'review'
            ? {
                OR: [
                  { status: 'unknown' },
                  { chainStatus: { in: ['compensation_failed', 'unknown'] } },
                  { unrequested: true },
                ],
              }
            : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: Math.max(1, Math.min(q.limit ?? 100, 300)),
      });
    const ops = new Map<string, OpRow | null>();
    const out: Array<ProposalView & { actor: string; channel: string }> = [];
    for (const r of rows) {
      if (!ops.has(r.operationRowId))
        ops.set(
          r.operationRowId,
          await this.opRow(accountId, siteId, r.operationRowId),
        );
      out.push({
        ...this.view(r, now, ops.get(r.operationRowId), q.lang ?? 'uk'),
        actor: r.actor,
        channel: r.channel,
      });
    }
    return out;
  }
}
