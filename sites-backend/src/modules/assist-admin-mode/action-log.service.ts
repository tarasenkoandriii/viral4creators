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
   * Заход 11: voice-map — голосовая карта «Админки».
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
  | 'voice-control'
  // Заход 11 (№117): изменения голосовой карты «Админки» (черновик, версии,
  // публикация, откат, ссылки и сессии редактора; §5-кватер.9 «Изоляция»).
  | 'voice-map';

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

/** Экспорт CSV — последние записи журнала сайта (голова — последняя строка). */
export const CSV_EXPORT_MAX_ROWS = 50_000;

/** Строк журнала за один запрос проверки цепочки (аудит Э8 (5)). */
export const VERIFY_CHAIN_BATCH = 2_000;

/** Голова цепочки сайта — внешний якорь (Р-З9-20). */
export interface ChainHeadView {
  id: string;
  at: string;
  hash: string;
}

@Injectable()
export class AdminActionLogService {
  /** Тесты: размер пачки проверки цепочки. */
  verifyBatch = VERIFY_CHAIN_BATCH;

  constructor(private readonly db: SitesDb) {}

  /** Последняя строка цепочки сайта (хеш, id, время) или null. */
  async chainHead(
    accountId: string,
    siteId: string,
  ): Promise<ChainHeadView | null> {
    const r = await this.db
      .forAccount(accountId)
      .assistAdminActionLog.findFirst({
        where: { siteId },
        orderBy: [{ at: 'desc' }, { id: 'desc' }],
        select: { id: true, at: true, hash: true },
      });
    return r ? { id: r.id, at: r.at.toISOString(), hash: r.hash } : null;
  }

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
   * Р-З9-20: первая строка — шапка-якорь `# chain-head` (хеш, id и время
   * последней строки ФАЙЛА — это и голова цепочки: в файл идут ПОСЛЕДНИЕ
   * `CSV_EXPORT_MAX_ROWS` записей по возрастанию), затем заголовок CSV;
   * колонка `id` — последняя (по ней владелец находит строку из отчёта
   * недели). Та же голова — в `head` (контроллер кладёт её в X-Chain-Head).
   */
  async exportCsv(
    accountId: string,
    siteId: string,
    now = new Date(),
  ): Promise<{ csv: string; head: ChainHeadView | null }> {
    const rows = (
      await this.db.forAccount(accountId).assistAdminActionLog.findMany({
        where: { siteId },
        orderBy: [{ at: 'desc' }, { id: 'desc' }],
        take: CSV_EXPORT_MAX_ROWS,
      })
    ).reverse();
    const last = rows.at(-1);
    const head: ChainHeadView | null = last
      ? { id: last.id, at: last.at.toISOString(), hash: last.hash }
      : null;
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
    const columns = [
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
      'id',
    ];
    const anchor = head
      ? `# chain-head: hash=${head.hash}; id=${head.id}; at=${head.at}; exported=${now.toISOString()}`
      : `# chain-head: empty; exported=${now.toISOString()}`;
    const lines = [anchor, columns.join(',')];
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
          r.id,
        ]
          .map(cell)
          .join(','),
      );
    }
    return { csv: `${lines.join('\n')}\n`, head };
  }

  /**
   * Проверка цепочки сайта (для тестов и экспорта): индекс первой битой
   * строки или -1. Аудит Э8 (5): пачками по `verifyBatch` строк (keyset по
   * `at, id`), а не весь журнал (≤ 365 дней) одним запросом; связь
   * `prevHash` проверяется и на стыке пачек.
   */
  async verifyChain(accountId: string, siteId: string): Promise<number> {
    const db = this.db.forAccount(accountId);
    const batch = Math.max(1, Math.min(this.verifyBatch, VERIFY_CHAIN_BATCH));
    let prev: { hash: string; at: Date; id: string } | null = null;
    let index = 0;
    for (;;) {
      const cursor: { at: Date; id: string } | null = prev;
      const rows: Prisma.AssistAdminActionLogGetPayload<object>[] =
        await db.assistAdminActionLog.findMany({
          where: cursor
            ? {
                siteId,
                OR: [
                  { at: { gt: cursor.at } },
                  { at: cursor.at, id: { gt: cursor.id } },
                ],
              }
            : { siteId },
          orderBy: [{ at: 'asc' }, { id: 'asc' }],
          take: batch,
        });
      for (const r of rows) {
        if (prev && r.prevHash !== prev.hash) return index;
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
          return index;
        }
        prev = { hash: r.hash, at: r.at, id: r.id };
        index++;
      }
      if (rows.length < batch) return -1;
    }
  }
}
