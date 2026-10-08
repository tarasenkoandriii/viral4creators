/**
 * Выгрузки CSV «Админки» (заход 10, №57; ТЗ §5-тер.7 «„Админка“ — отдельный
 * экспорт под `assistAdmin: owner`», §5-тер.13 У-25).
 *
 *  - запрос → assist_admin_exports (queued) → крон assist-admin-embed-run
 *    формирует файл в приватный Blob (`…/admin-exports/<id>.csv`), ссылка
 *    24 ч; строка — журнал выгрузок (кто, что, когда), живёт год;
 *  - виды: `daily` (свёртка день × роль), `labels` (разметка диалогов: тип
 *    задачи, нашёл ли ответ, ошибка инструмента — без текста реплик),
 *    `actions` (предложения «Да»: операция, исход — без параметров);
 *    сотрудник (`employeeRef`) — только при включённом владельцем разрезе
 *    «по сотруднику» (§5-тер.13 — по умолчанию агрегаты по ролям);
 *  - ≤ 50 000 строк: больше — `failed` (`too_many_rows`), а не молча
 *    обрезанный файл; период — дни UTC, ≤ 400 дней;
 *  - захват — FOR UPDATE SKIP LOCKED, 3 попытки. В лог — id и код.
 */
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SitesDb } from '../../prisma/sites-db.service';
import type { AccountMembership } from '../site-core/account/roles';
import { adminError } from '../assist-admin-mode/admin-errors';
import { AdminModeService } from '../assist-admin-mode/admin-mode.service';
import { type AdminCsvCell, adminCsv } from './admin-csv';
import {
  AdminExportStorage,
  adminExportBlobPathname,
} from './admin-export-storage';
import { addDaysIso } from './admin-report-text';

export const ADMIN_EXPORT_KINDS = ['daily', 'labels', 'actions'] as const;
export type AdminExportKind = (typeof ADMIN_EXPORT_KINDS)[number];
export const ADMIN_EXPORT_MAX_ROWS = 50_000;
export const ADMIN_EXPORT_MAX_DAYS = 400;
export const ADMIN_EXPORT_LINK_TTL_MS = 24 * 60 * 60 * 1000;
/** P2-1: выгрузок сайта в очереди и в работе — не больше. */
export const ADMIN_EXPORT_MAX_PENDING = 3;
const LEASE_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const JOURNAL_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export interface AdminExportView {
  id: string;
  kind: AdminExportKind;
  status: 'queued' | 'running' | 'done' | 'failed' | 'expired';
  rows: number | null;
  url: string | null;
  error: string | null;
  expiresAt: string | null;
  createdAt: string;
}

const SELECT = {
  id: true,
  kind: true,
  status: true,
  rows: true,
  blobKey: true,
  error: true,
  expiresAt: true,
  createdAt: true,
} as const;

function validDay(v: unknown): v is string {
  if (typeof v !== 'string' || !DAY.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** Проверка запроса: вид, дни, порядок, длина. */
export function parseAdminExport(b: {
  kind?: unknown;
  from?: unknown;
  to?: unknown;
}): { kind: AdminExportKind; from: string; to: string } {
  if (!(ADMIN_EXPORT_KINDS as readonly unknown[]).includes(b.kind)) {
    throw adminError(
      400,
      'ADMIN_EXPORT_INVALID',
      'kind: daily | labels | actions',
    );
  }
  if (!validDay(b.from) || !validDay(b.to) || b.from > b.to) {
    throw adminError(
      400,
      'ADMIN_EXPORT_INVALID',
      'Период: from ≤ to, дни YYYY-MM-DD',
    );
  }
  if (addDaysIso(b.from, ADMIN_EXPORT_MAX_DAYS) <= b.to) {
    throw adminError(
      400,
      'ADMIN_EXPORT_INVALID',
      `Период не длиннее ${ADMIN_EXPORT_MAX_DAYS} дней`,
    );
  }
  return { kind: b.kind as AdminExportKind, from: b.from, to: b.to };
}

@Injectable()
export class AdminExports {
  private readonly logger = new Logger(AdminExports.name);
  now: () => Date = () => new Date();
  maxRows = ADMIN_EXPORT_MAX_ROWS;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sitesDb: SitesDb,
    private readonly mode: AdminModeService,
    private readonly storage: AdminExportStorage,
  ) {}

  private async view(r: {
    id: string;
    kind: string;
    status: string;
    rows: number | null;
    blobKey: string | null;
    error: string | null;
    expiresAt: Date | null;
    createdAt: Date;
  }): Promise<AdminExportView> {
    const now = this.now();
    let status = r.status as AdminExportView['status'];
    if (status === 'done' && r.expiresAt && r.expiresAt <= now) {
      status = 'expired';
    }
    const url =
      status === 'done' && r.blobKey && r.expiresAt
        ? await this.storage.signedUrl(r.blobKey, r.expiresAt).catch(() => null)
        : null;
    return {
      id: r.id,
      kind: r.kind as AdminExportKind,
      status,
      rows: r.rows,
      url,
      error: status === 'failed' ? r.error : null,
      expiresAt:
        status === 'done' ? (r.expiresAt?.toISOString() ?? null) : null,
      createdAt: r.createdAt.toISOString(),
    };
  }

  async request(
    m: AccountMembership,
    siteId: string,
    body: { kind?: unknown; from?: unknown; to?: unknown },
  ): Promise<AdminExportView> {
    const req = parseAdminExport(body);
    await this.mode.requireSite(m.accountId, siteId);
    await this.mode.ensureSettings(m.accountId, siteId);
    // Аудит захода 10 (P2-1): очередь сайта — не больше 3 выгрузок в работе;
    // остальные сайты не ждут за одним кабинетом.
    const busy = await this.sitesDb
      .forAccount(m.accountId)
      .assistAdminExport.count({
        where: { siteId, status: { in: ['queued', 'running'] } },
      });
    if (busy >= ADMIN_EXPORT_MAX_PENDING) {
      throw adminError(
        409,
        'ADMIN_EXPORT_BUSY',
        `Уже формируются ${busy} выгрузки — дождитесь их`,
      );
    }
    const row = await this.sitesDb
      .forAccount(m.accountId)
      .assistAdminExport.create({
        data: {
          accountId: m.accountId,
          siteId,
          kind: req.kind,
          params: { from: req.from, to: req.to },
          requestedByTelegramId: m.telegramId,
          createdAt: this.now(),
        },
        select: SELECT,
      });
    this.logger.log(`выгрузка «Админки» ${row.id} в очереди (${req.kind})`);
    return this.view(row);
  }

  async list(m: AccountMembership, siteId: string): Promise<AdminExportView[]> {
    await this.mode.requireSite(m.accountId, siteId);
    const rows = await this.sitesDb
      .forAccount(m.accountId)
      .assistAdminExport.findMany({
        where: { siteId },
        select: SELECT,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 30,
      });
    return Promise.all(rows.map((r) => this.view(r)));
  }

  async get(
    m: AccountMembership,
    siteId: string,
    exportId: string,
  ): Promise<AdminExportView> {
    await this.mode.requireSite(m.accountId, siteId);
    const row = await this.sitesDb
      .forAccount(m.accountId)
      .assistAdminExport.findFirst({
        where: { id: exportId, siteId },
        select: SELECT,
      });
    if (!row) {
      throw adminError(404, 'ADMIN_EXPORT_NOT_FOUND', 'Выгрузка не найдена');
    }
    return this.view(row);
  }

  /** Крон: сформировать до `limit` выгрузок; просроченные — expired + Blob прочь. */
  async process(
    limit: number,
    now: Date,
    siteIds?: string[] | null,
  ): Promise<{ done: number; failed: number; expired: number }> {
    const ids = siteIds ?? null;
    const expired = await this.expire(now, ids);
    // P3 (1): зависшие после исчерпания попыток (функцию убили посреди
    // сборки) — `failed`, а не вечная очередь.
    await this.prisma.$executeRawUnsafe(
      `UPDATE "sites"."assist_admin_exports"
            SET "status" = 'failed', "error" = 'attempts_exhausted', "lockedUntil" = NULL
          WHERE "status" IN ('queued', 'running') AND "attempts" >= $1
            AND ("status" = 'queued' OR "lockedUntil" < $2)
            AND ($3::text[] IS NULL OR "siteId" = ANY($3::text[]))`,
      MAX_ATTEMPTS,
      now,
      ids,
    );
    const claimed = await this.prisma.$queryRawUnsafe<
      Array<{
        id: string;
        accountId: string;
        siteId: string;
        kind: string;
        params: unknown;
        attempts: number;
      }>
    >(
      // P2-1: справедливый захват — не больше одной выгрузки на сайт за тик
      // (самая старая каждого сайта, DISTINCT ON); P3 (1): попыток < 3.
      `WITH cand AS (
         SELECT d."id" FROM (
           SELECT DISTINCT ON ("siteId") "id", "createdAt"
             FROM "sites"."assist_admin_exports"
            WHERE ("status" = 'queued' OR ("status" = 'running' AND "lockedUntil" < $2))
              AND "attempts" < $5
              AND ($4::text[] IS NULL OR "siteId" = ANY($4::text[]))
            ORDER BY "siteId", "createdAt") d
          ORDER BY d."createdAt" LIMIT $3
       ), locked AS (
         SELECT t."id" FROM "sites"."assist_admin_exports" t
          WHERE t."id" IN (SELECT "id" FROM cand)
          FOR UPDATE SKIP LOCKED
       )
       UPDATE "sites"."assist_admin_exports" x
          SET "status" = 'running', "lockedUntil" = $1, "attempts" = x."attempts" + 1
         FROM locked
        WHERE x."id" = locked."id"
          AND (x."status" = 'queued' OR (x."status" = 'running' AND x."lockedUntil" < $2))
          AND x."attempts" < $5
        RETURNING x."id", x."accountId", x."siteId", x."kind", x."params", x."attempts"`,
      new Date(now.getTime() + LEASE_MS),
      now,
      Math.max(1, limit),
      ids,
      MAX_ATTEMPTS,
    );
    let done = 0;
    let failed = 0;
    for (const x of claimed) {
      const db = this.sitesDb.forAccount(x.accountId);
      try {
        const csv = await this.build(x);
        if (csv === null) {
          await db.assistAdminExport.updateMany({
            where: { id: x.id },
            data: {
              status: 'failed',
              error: 'too_many_rows',
              lockedUntil: null,
            },
          });
          failed++;
          continue;
        }
        const blobKey = adminExportBlobPathname({
          accountId: x.accountId,
          siteId: x.siteId,
          exportId: x.id,
        });
        await this.storage.put(blobKey, csv.text);
        await db.assistAdminExport.updateMany({
          where: { id: x.id },
          data: {
            status: 'done',
            blobKey,
            rows: csv.rows,
            error: null,
            lockedUntil: null,
            finishedAt: now,
            expiresAt: new Date(now.getTime() + ADMIN_EXPORT_LINK_TTL_MS),
          },
        });
        done++;
        this.logger.log(`выгрузка «Админки» ${x.id} готова (${csv.rows})`);
      } catch (e) {
        const last = x.attempts >= MAX_ATTEMPTS;
        await db.assistAdminExport.updateMany({
          where: { id: x.id },
          data: {
            status: last ? 'failed' : 'queued',
            error: (e as Error | null)?.name ?? 'Error',
            lockedUntil: null,
          },
        });
        if (last) failed++;
        this.logger.warn(
          `выгрузка «Админки» ${x.id}: сбой (${(e as Error | null)?.name ?? 'Error'})`,
        );
      }
    }
    return { done, failed, expired };
  }

  /** Журнал выгрузок — год (уборка раз в сутки, `AdminAnalyticsRunner`). */
  async purgeJournal(now: Date, siteIds?: string[] | null): Promise<number> {
    return this.prisma.$executeRawUnsafe(
      `DELETE FROM "sites"."assist_admin_exports"
        WHERE "createdAt" < $1 AND "status" IN ('expired', 'failed')
          AND ($2::text[] IS NULL OR "siteId" = ANY($2::text[]))`,
      new Date(now.getTime() - JOURNAL_RETENTION_MS),
      siteIds ?? null,
    );
  }

  private async expire(now: Date, ids: string[] | null): Promise<number> {
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{ id: string; accountId: string; blobKey: string | null }>
    >(
      `SELECT "id", "accountId", "blobKey" FROM "sites"."assist_admin_exports"
        WHERE "status" = 'done' AND "expiresAt" <= $1
          AND ($2::text[] IS NULL OR "siteId" = ANY($2::text[]))
        LIMIT 100`,
      now,
      ids,
    );
    let n = 0;
    for (const r of rows) {
      if (r.blobKey) {
        try {
          await this.storage.remove(r.blobKey);
        } catch (e) {
          this.logger.warn(
            `выгрузка «Админки» ${r.id}: файл не удалён (${(e as Error).name})`,
          );
          continue;
        }
      }
      await this.sitesDb.forAccount(r.accountId).assistAdminExport.updateMany({
        where: { id: r.id },
        data: { status: 'expired', blobKey: null },
      });
      n++;
    }
    return n;
  }

  /** CSV выгрузки; null — больше `maxRows` строк. */
  async build(x: {
    accountId: string;
    siteId: string;
    kind: string;
    params: unknown;
  }): Promise<{ text: string; rows: number } | null> {
    const params = (x.params ?? {}) as { from?: unknown; to?: unknown };
    if (!validDay(params.from) || !validDay(params.to)) {
      throw new Error('bad_params');
    }
    const from = params.from;
    const to = params.to;
    const range = {
      gte: new Date(`${from}T00:00:00Z`),
      lt: new Date(`${addDaysIso(to, 1)}T00:00:00Z`),
    };
    const max = this.maxRows;
    const db = this.sitesDb.forAccount(x.accountId);
    if (x.kind === 'daily') {
      const rows = await db.assistAdminDailyStat.findMany({
        where: { siteId: x.siteId, day: { gte: from, lte: to } },
        orderBy: [{ day: 'asc' }, { role: 'asc' }],
        take: max + 1,
      });
      if (rows.length > max) return null;
      const header = [
        'date',
        'role',
        'conversations',
        'questions',
        'refused',
        'thumbs_down',
        'labeled',
        'answer_yes',
        'answer_partial',
        'tool_errors',
        'actions_proposed',
        'actions_confirmed',
        'actions_failed',
        'minutes_saved',
        'cost_usd',
      ];
      const out: AdminCsvCell[][] = rows.map((r) => [
        r.day,
        r.role,
        r.conversations,
        r.questions,
        r.refused,
        r.thumbsDown,
        r.labeled,
        r.answerYes,
        r.answerPartial,
        r.toolErrors,
        r.proposed,
        r.confirmed,
        r.actionsFailed,
        r.minutesSaved,
        r.costMicroUsd / 1_000_000,
      ]);
      return { text: adminCsv(header, out), rows: out.length };
    }
    const settings = await db.assistAdminSettings.findFirst({
      where: { siteId: x.siteId },
      select: { statsPerEmployee: true },
    });
    const perEmployee = settings?.statsPerEmployee === true;
    if (x.kind === 'labels') {
      const rows = await db.assistAdminConversationLabel.findMany({
        where: { siteId: x.siteId, conversationAt: range },
        orderBy: [{ conversationAt: 'asc' }, { conversationId: 'asc' }],
        take: max + 1,
        select: {
          conversationId: true,
          conversationAt: true,
          employeeRole: true,
          taskType: true,
          answerFound: true,
          toolError: true,
          quality: true,
          status: true,
          conversation: { select: { channel: true, employeeRef: true } },
        },
      });
      if (rows.length > max) return null;
      // P3 (7): без разреза «по сотруднику» — дата вместо времени и без id
      // диалога: точное время + id сводятся с журналом к конкретному человеку.
      const header = [
        ...(perEmployee ? ['conversation_id', 'time'] : ['date']),
        'channel',
        'role',
        ...(perEmployee ? ['employee'] : []),
        'task_type',
        'answer_found',
        'tool_error',
        'quality',
        'label_status',
      ];
      const out: AdminCsvCell[][] = rows.map((r) => [
        ...(perEmployee
          ? [r.conversationId, r.conversationAt.toISOString()]
          : [r.conversationAt.toISOString().slice(0, 10)]),
        r.conversation.channel,
        r.employeeRole,
        ...(perEmployee ? [r.conversation.employeeRef] : []),
        r.taskType,
        r.answerFound,
        r.toolError,
        r.quality,
        r.status,
      ]);
      return { text: adminCsv(header, out), rows: out.length };
    }
    if (x.kind === 'actions') {
      const rows = await db.assistAdminActionProposal.findMany({
        where: { siteId: x.siteId, createdAt: range },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: max + 1,
        select: {
          id: true,
          createdAt: true,
          channel: true,
          actor: true,
          actorRole: true,
          operation: true,
          kind: true,
          status: true,
          attempts: true,
          outcome: true,
          compensationOf: true,
          chainStatus: true,
          unrequested: true,
          executedAt: true,
        },
      });
      if (rows.length > max) return null;
      const header = [
        'proposal_id',
        'time',
        'channel',
        'role',
        ...(perEmployee ? ['employee'] : []),
        'operation',
        'kind',
        'status',
        'attempts',
        'outcome',
        'compensation',
        'chain_status',
        'unrequested',
        'executed_at',
      ];
      const out: AdminCsvCell[][] = rows.map((r) => [
        r.id,
        r.createdAt.toISOString(),
        r.channel,
        r.actorRole,
        ...(perEmployee ? [r.actor] : []),
        r.operation,
        r.kind,
        r.status,
        r.attempts,
        r.outcome,
        r.compensationOf !== null,
        r.chainStatus,
        r.unrequested,
        r.executedAt?.toISOString() ?? null,
      ]);
      return { text: adminCsv(header, out), rows: out.length };
    }
    throw new Error('bad_kind');
  }
}
