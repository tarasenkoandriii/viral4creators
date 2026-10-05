/**
 * Журнал вызовов инструментов «Админки» (ТЗ §3.8 п.6, §5.7; приёмка Э7:
 * «секрет не встречается ни в журнале, ни в логах»).
 *
 * Только дописывается (UPDATE/DELETE отвергает триггер миграции
 * …_assist_admin_read), каждая строка несёт `hash = SHA-256(prevHash +
 * поля)` в пределах сайта; параллельные записи сайта сериализует
 * advisory-lock транзакции — две строки не возьмут один `prevHash`.
 *
 * Что пишется: кто (`jwt:<sub>`/`tg:<id>`), какая операция, исход, код
 * HTTP, длительность, маскированный запрос (метод, шаблон пути со
 * значениями, query; БЕЗ заголовков — авторизация туда не попадает по
 * построению), размер ответа. Тела ответа API нет никогда (§5.4: результаты
 * инструментов не хранятся).
 */
import { createHash, randomUUID } from 'crypto';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { SitesDb } from '../../prisma/sites-db.service';

export interface ActionLogEntry {
  accountId: string;
  siteId: string;
  actor: string;
  actorRole: string | null;
  channel: 'embed' | 'tma';
  conversationId: string | null;
  connectorId: string | null;
  operationRowId: string | null;
  operation: string;
  /**
   * read — вызов чтения (Э7); write/danger — исполнение «Да» (Э8);
   * proposal — предложение создано; decision — «Нет»/истекло; chain —
   * статус цепочки (компенсация, §5-бис.15 п.11); memo — изменение мемо
   * АМ-N (§5-бис.17 п.10); Э6-бис (б): ui-plan / ui-step / ui-test /
   * voice-control — голосовое управление «Админкой».
   */
  kind?: ActionLogKind;
  outcome: string;
  httpStatus: number | null;
  durationMs: number | null;
  requestMasked: Prisma.InputJsonValue;
  responseBytes: number | null;
  error: string | null;
}

export type ActionLogKind =
  | 'read'
  | 'write'
  | 'danger'
  | 'proposal'
  | 'decision'
  | 'chain'
  | 'memo'
  // Э6-бис (б): голосовое управление «Админкой» (§5-бис.9, §5-бис.13):
  // план и «Да»/стоп, каждый шаг (значения — маской), отчёт мастера,
  // смена переключателя и принятые риски («журнал кабинета» §5-бис.2).
  | 'ui-plan'
  | 'ui-step'
  | 'ui-test'
  | 'voice-control';

export interface ActionLogView {
  id: string;
  at: string;
  actor: string;
  actorRole: string | null;
  channel: string;
  operation: string;
  kind: string;
  outcome: string;
  httpStatus: number | null;
  durationMs: number | null;
  request: unknown;
  responseBytes: number | null;
  error: string | null;
}

/** JSON с ключами по алфавиту на всех уровнях: jsonb переставляет ключи. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .filter((k) => o[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

/** Хеш строки: порядок полей фиксирован (JSON массива, а не объекта). */
export function actionLogHash(
  prevHash: string | null,
  e: ActionLogEntry,
  at: Date,
  idempotencyKey: string,
): string {
  return createHash('sha256')
    .update(
      canonicalJson([
        prevHash ?? '',
        at.toISOString(),
        e.siteId,
        e.actor,
        e.actorRole,
        e.channel,
        e.conversationId,
        e.operation,
        e.kind ?? 'read',
        e.outcome,
        e.httpStatus,
        e.requestMasked,
        e.responseBytes,
        e.error,
        idempotencyKey,
      ]),
    )
    .digest('hex');
}

@Injectable()
export class AdminActionLogService {
  constructor(private readonly db: SitesDb) {}

  /**
   * `key` — уникальный ключ строки (Э8: `exec:<предложение>:<попытка>` —
   * одно исполнение не попадёт в журнал дважды); без него — случайный.
   */
  async append(
    e: ActionLogEntry,
    now = new Date(),
    key?: string,
  ): Promise<string> {
    const db = this.db.forAccount(e.accountId);
    const idempotencyKey = key ?? `${e.kind ?? 'read'}:${randomUUID()}`;
    return db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`assist-admin-log:${e.siteId}`}))`;
      const last = await tx.assistAdminActionLog.findFirst({
        where: { siteId: e.siteId },
        orderBy: [{ at: 'desc' }, { id: 'desc' }],
        select: { hash: true, at: true },
      });
      // Время строки не раньше предыдущей — порядок цепочки = порядок `at`.
      const at =
        last && last.at.getTime() >= now.getTime()
          ? new Date(last.at.getTime() + 1)
          : now;
      const prevHash = last?.hash ?? null;
      const row = await tx.assistAdminActionLog.create({
        data: {
          accountId: e.accountId,
          siteId: e.siteId,
          at,
          actor: e.actor,
          actorRole: e.actorRole,
          channel: e.channel,
          conversationId: e.conversationId,
          connectorId: e.connectorId,
          operationRowId: e.operationRowId,
          operation: e.operation.slice(0, 200),
          kind: e.kind ?? 'read',
          outcome: e.outcome,
          httpStatus: e.httpStatus,
          durationMs: e.durationMs,
          requestMasked: e.requestMasked,
          responseBytes: e.responseBytes,
          error: e.error,
          idempotencyKey,
          prevHash,
          hash: actionLogHash(prevHash, e, at, idempotencyKey),
        },
        select: { id: true },
      });
      return row.id;
    });
  }

  async list(
    accountId: string,
    siteId: string,
    q: {
      actor?: string;
      outcome?: string;
      operation?: string;
      kind?: string;
      limit?: number;
    },
  ): Promise<ActionLogView[]> {
    const rows = await this.db
      .forAccount(accountId)
      .assistAdminActionLog.findMany({
        where: {
          siteId,
          ...(q.actor ? { actor: q.actor } : {}),
          ...(q.outcome ? { outcome: q.outcome } : {}),
          ...(q.operation ? { operation: q.operation } : {}),
          ...(q.kind === 'actions'
            ? { kind: { in: ['write', 'danger', 'proposal', 'decision'] } }
            : q.kind
              ? { kind: q.kind }
              : {}),
        },
        orderBy: [{ at: 'desc' }, { id: 'desc' }],
        take: Math.max(1, Math.min(q.limit ?? 100, 500)),
      });
    return rows.map((r) => ({
      id: r.id,
      at: r.at.toISOString(),
      actor: r.actor,
      actorRole: r.actorRole,
      channel: r.channel,
      operation: r.operation,
      kind: r.kind,
      outcome: r.outcome,
      httpStatus: r.httpStatus,
      durationMs: r.durationMs,
      request: r.requestMasked,
      responseBytes: r.responseBytes,
      error: r.error,
    }));
  }

  /**
   * Экспорт журнала сайта в CSV (§5.7 «экспорт CSV»): строки уже маскированы
   * при записи (секретов и тел ответа нет по построению); хеш и prevHash —
   * чтобы получатель мог сам проверить цепочку. Ячейки — с защитой от формул.
   */
  async exportCsv(accountId: string, siteId: string): Promise<string> {
    const rows = await this.db
      .forAccount(accountId)
      .assistAdminActionLog.findMany({
        where: { siteId },
        orderBy: [{ at: 'asc' }, { id: 'asc' }],
        take: 50_000,
      });
    const cell = (v: unknown): string => {
      let s =
        v === null || v === undefined
          ? ''
          : typeof v === 'object'
            ? canonicalJson(v)
            : String(v);
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
      return `"${s.replace(/"/g, '""')}"`;
    };
    const head = [
      'at',
      'actor',
      'actorRole',
      'channel',
      'operation',
      'kind',
      'outcome',
      'httpStatus',
      'durationMs',
      'request',
      'responseBytes',
      'error',
      'key',
      'prevHash',
      'hash',
    ];
    const lines = [head.join(',')];
    for (const r of rows) {
      lines.push(
        [
          r.at.toISOString(),
          r.actor,
          r.actorRole,
          r.channel,
          r.operation,
          r.kind,
          r.outcome,
          r.httpStatus,
          r.durationMs,
          r.requestMasked,
          r.responseBytes,
          r.error,
          r.idempotencyKey,
          r.prevHash,
          r.hash,
        ]
          .map(cell)
          .join(','),
      );
    }
    return `${lines.join('\n')}\n`;
  }

  /** Проверка цепочки сайта (для тестов и экспорта): индекс первой битой строки или -1. */
  async verifyChain(accountId: string, siteId: string): Promise<number> {
    const rows = await this.db
      .forAccount(accountId)
      .assistAdminActionLog.findMany({
        where: { siteId },
        orderBy: [{ at: 'asc' }, { id: 'asc' }],
      });
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (i > 0 && r.prevHash !== rows[i - 1].hash) return i;
      const e: ActionLogEntry = {
        accountId: r.accountId,
        siteId: r.siteId,
        actor: r.actor,
        actorRole: r.actorRole,
        channel: r.channel as 'embed' | 'tma',
        conversationId: r.conversationId,
        connectorId: r.connectorId,
        operationRowId: r.operationRowId,
        operation: r.operation,
        kind: r.kind as ActionLogKind,
        outcome: r.outcome,
        httpStatus: r.httpStatus,
        durationMs: r.durationMs,
        requestMasked: r.requestMasked as Prisma.InputJsonValue,
        responseBytes: r.responseBytes,
        error: r.error,
      };
      if (actionLogHash(r.prevHash, e, r.at, r.idempotencyKey) !== r.hash) {
        return i;
      }
    }
    return -1;
  }
}
