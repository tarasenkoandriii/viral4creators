/**
 * Экспорт CSV — A (ТЗ §5-тер.7): запрос → assist_site_exports (queued) →
 * крон assist-analytics-run формирует файл (csv.ts) в приватный Blob
 * (`assist/<accountId>/<siteId>/exports/<id>.csv`, blob-storage.ts Э1),
 * ссылка 24 ч, ≤ 100 тыс. строк. Текст реплик — только владелец и только
 * маскированный. Каждая выгрузка — запись журнала (сама строка, 1 год).
 *
 * Уточнения A:
 *  - период — дни `YYYY-MM-DD` в поясе сайта, ≤ 400 дней
 *    (`STATS_RANGE_INVALID`);
 *  - `dialogs` без текста — строка на диалог; с текстом (владелец) — строка
 *    на реплику: текст в своей ячейке, и защита от CSV-инъекции
 *    срабатывает на начале реплики (§5-тер.16 п.8); текст ещё раз
 *    проходит maskForJournal (ответ оператора хранится как написан);
 *  - больше 100 тыс. строк — выгрузка `failed` (`too_many_rows`), а не
 *    молча обрезанный файл: пусть выберут период короче;
 *  - захват — условным UPDATE (FOR UPDATE SKIP LOCKED), 3 попытки;
 *  - журнал (строки assist_site_exports) живёт год, файл — 24 ч.
 * В лог — id выгрузки и код; ни строк, ни текста.
 */
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ANALYTICS_DEFAULTS } from '../../config/assist-defaults';
import type { CronScope } from '../../common/cron-scope';
import { PrismaService } from '../../prisma/prisma.service';
import { SitesDb } from '../../prisma/sites-db.service';
import { maskForJournal } from '../assist-site-chat/answer-checks';
import type { AccountMembership } from '../site-core/account/roles';
import { analyticsError, notFoundSite } from './analytics-errors';
import type { ExportRequest, ExportView } from './api-types';
import { csvRows } from './csv';
import { ExportStorage, exportBlobPathname } from './export-storage';
import { addDays, dayRangeUtc, siteTz, validDay } from './site-time';

export const EXPORT_MAX_DAYS = 400;
const EXPORT_LEASE_MS = 5 * 60 * 1000;
const EXPORT_MAX_ATTEMPTS = 3;
const JOURNAL_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;
const KINDS = ['daily', 'conversions', 'dialogs'] as const;

type Cell = string | number | boolean | null;

interface ExportRow {
  id: string;
  kind: string;
  status: string;
  rows: number | null;
  blobKey: string | null;
  expiresAt: Date | null;
  withText: boolean;
  createdAt: Date;
}

const VIEW_SELECT = {
  id: true,
  kind: true,
  status: true,
  rows: true,
  blobKey: true,
  expiresAt: true,
  withText: true,
  createdAt: true,
} as const;

function rangeInvalid(message: string) {
  return analyticsError(HttpStatus.BAD_REQUEST, 'STATS_RANGE_INVALID', message);
}

/** Проверка периода запроса: дни, порядок, длина. */
export function parseExportRequest(body: unknown): ExportRequest {
  const b =
    body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  if (!b) {
    throw analyticsError(HttpStatus.BAD_REQUEST, 'BAD_REQUEST', 'Нужен JSON');
  }
  for (const k of Object.keys(b)) {
    if (!['kind', 'from', 'to', 'withText'].includes(k)) {
      throw analyticsError(
        HttpStatus.BAD_REQUEST,
        'BAD_REQUEST',
        `Лишнее поле ${k}`,
      );
    }
  }
  if (!(KINDS as readonly unknown[]).includes(b.kind)) {
    throw analyticsError(
      HttpStatus.BAD_REQUEST,
      'BAD_REQUEST',
      'kind: daily | conversions | dialogs',
    );
  }
  if (!validDay(b.from) || !validDay(b.to) || b.from > b.to) {
    throw rangeInvalid('Период: from ≤ to, дни YYYY-MM-DD');
  }
  if (addDays(b.from, EXPORT_MAX_DAYS) <= b.to) {
    throw rangeInvalid(`Период не длиннее ${EXPORT_MAX_DAYS} дней`);
  }
  if (b.withText !== undefined && typeof b.withText !== 'boolean') {
    throw analyticsError(
      HttpStatus.BAD_REQUEST,
      'BAD_REQUEST',
      'withText: boolean',
    );
  }
  if (b.withText === true && b.kind !== 'dialogs') {
    throw analyticsError(
      HttpStatus.BAD_REQUEST,
      'BAD_REQUEST',
      'Текст — только в выгрузке диалогов',
    );
  }
  return {
    kind: b.kind as ExportRequest['kind'],
    from: b.from,
    to: b.to,
    withText: b.withText === true,
  };
}

@Injectable()
export class ExportsService {
  private readonly logger = new Logger(ExportsService.name);
  now: () => Date = () => new Date();

  constructor(
    private readonly sitesDb: SitesDb,
    private readonly prisma: PrismaService,
    private readonly storage: ExportStorage,
  ) {}

  private async site(m: AccountMembership, siteId: string) {
    const db = this.sitesDb.forAccount(m.accountId);
    const site = await db.site.findFirst({
      where: { id: siteId },
      select: { id: true },
    });
    if (!site) throw notFoundSite();
    return db;
  }

  private async view(m: AccountMembership, r: ExportRow): Promise<ExportView> {
    const now = this.now();
    let status = r.status as ExportView['status'];
    let url: string | null = null;
    if (status === 'done' && r.expiresAt && r.expiresAt <= now)
      status = 'expired';
    // Текст реплик выгружает только владелец (§5-тер.7) — и скачивает тоже
    // только он: иначе менеджер получил бы подписанную ссылку на файл
    // владельца из списка выгрузок.
    const mayDownload = !r.withText || m.role === 'owner';
    if (status === 'done' && r.blobKey && r.expiresAt && mayDownload) {
      url = await this.storage
        .signedUrl(r.blobKey, r.expiresAt)
        .catch(() => null);
    }
    return {
      id: r.id,
      kind: r.kind as ExportView['kind'],
      status,
      rows: r.rows,
      url,
      expiresAt:
        status === 'done' ? (r.expiresAt?.toISOString() ?? null) : null,
      createdAt: r.createdAt.toISOString(),
    };
  }

  async request(
    m: AccountMembership,
    siteId: string,
    body: ExportRequest,
  ): Promise<ExportView> {
    const req = parseExportRequest(body);
    if (req.withText && m.role !== 'owner') {
      throw analyticsError(
        HttpStatus.FORBIDDEN,
        'EXPORT_FORBIDDEN',
        'Текст реплик выгружает только владелец кабинета',
      );
    }
    const db = await this.site(m, siteId);
    const row = await db.assistSiteExport.create({
      data: {
        accountId: m.accountId,
        siteId,
        kind: req.kind,
        params: { from: req.from, to: req.to },
        withText: req.withText === true,
        requestedByTelegramId: m.telegramId,
        createdAt: this.now(),
      },
      select: VIEW_SELECT,
    });
    this.logger.log(
      `выгрузка ${row.id} в очереди (site ${siteId}, ${req.kind})`,
    );
    return this.view(m, row);
  }

  async get(
    m: AccountMembership,
    siteId: string,
    exportId: string,
  ): Promise<ExportView> {
    const db = await this.site(m, siteId);
    const row = await db.assistSiteExport.findFirst({
      where: { id: exportId, siteId },
      select: VIEW_SELECT,
    });
    if (!row) {
      throw analyticsError(
        HttpStatus.NOT_FOUND,
        'EXPORT_NOT_FOUND',
        'Выгрузка не найдена',
      );
    }
    return this.view(m, row);
  }

  async list(m: AccountMembership, siteId: string): Promise<ExportView[]> {
    const db = await this.site(m, siteId);
    const rows = await db.assistSiteExport.findMany({
      where: { siteId },
      select: VIEW_SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 50,
    });
    return Promise.all(rows.map((r) => this.view(m, r)));
  }

  /** Крон: сформировать до `limit` выгрузок; просроченные — expired + удалить Blob. */
  /** Крон: `scope` — только тесты на общей базе (контракт Э3 §9 п.6). */
  async process(
    limit: number,
    now: Date,
    scope?: CronScope,
  ): Promise<{ done: number; failed: number; expired: number }> {
    const ids = scope ? scope.siteIds : null;
    const expired = await this.expire(now, ids);
    const claimed = await this.prisma.$queryRawUnsafe<
      Array<{
        id: string;
        accountId: string;
        siteId: string;
        kind: string;
        params: unknown;
        withText: boolean;
        attempts: number;
      }>
    >(
      `UPDATE "sites"."assist_site_exports" x
          SET "status" = 'running', "lockedUntil" = $1, "attempts" = x."attempts" + 1
        WHERE x."id" IN (
          SELECT "id" FROM "sites"."assist_site_exports"
           WHERE ("status" = 'queued' OR ("status" = 'running' AND "lockedUntil" < $2))
             AND ($4::text[] IS NULL OR "siteId" = ANY($4::text[]))
           ORDER BY "createdAt" LIMIT $3
           FOR UPDATE SKIP LOCKED)
        RETURNING x."id", x."accountId", x."siteId", x."kind", x."params", x."withText", x."attempts"`,
      new Date(now.getTime() + EXPORT_LEASE_MS),
      now,
      Math.max(1, limit),
      ids,
    );
    let done = 0;
    let failed = 0;
    for (const x of claimed) {
      try {
        const csv = await this.build(x);
        if (csv === null) {
          await this.finish(x.id, { status: 'failed', error: 'too_many_rows' });
          failed++;
          continue;
        }
        const blobKey = exportBlobPathname({
          accountId: x.accountId,
          siteId: x.siteId,
          exportId: x.id,
        });
        await this.storage.put(blobKey, csv.text);
        await this.prisma.assistSiteExport.update({
          where: { id: x.id },
          data: {
            status: 'done',
            blobKey,
            rows: csv.rows,
            error: null,
            lockedUntil: null,
            finishedAt: now,
            expiresAt: new Date(
              now.getTime() + ANALYTICS_DEFAULTS.exportLinkTtlMs,
            ),
          },
          select: { id: true },
        });
        done++;
        this.logger.log(`выгрузка ${x.id} готова (${csv.rows})`);
      } catch (e) {
        const last = x.attempts >= EXPORT_MAX_ATTEMPTS;
        await this.finish(x.id, {
          status: last ? 'failed' : 'queued',
          error: (e as Error | null)?.name ?? 'Error',
        });
        if (last) failed++;
        this.logger.warn(
          `выгрузка ${x.id}: сбой (${(e as Error | null)?.name ?? 'Error'})`,
        );
      }
    }
    // Журнал выгрузок — год (§5-тер.15).
    await this.prisma.$executeRawUnsafe(
      `DELETE FROM "sites"."assist_site_exports"
        WHERE "createdAt" < $1 AND "status" IN ('expired', 'failed')
          AND ($2::text[] IS NULL OR "siteId" = ANY($2::text[]))`,
      new Date(now.getTime() - JOURNAL_RETENTION_MS),
      ids,
    );
    return { done, failed, expired };
  }

  private async finish(
    id: string,
    p: { status: 'failed' | 'queued'; error: string },
  ): Promise<void> {
    await this.prisma.assistSiteExport.update({
      where: { id },
      data: { status: p.status, error: p.error, lockedUntil: null },
      select: { id: true },
    });
  }

  private async expire(now: Date, ids: string[] | null): Promise<number> {
    const rows = await this.prisma.assistSiteExport.findMany({
      where: {
        status: 'done',
        expiresAt: { lte: now },
        ...(ids ? { siteId: { in: ids } } : {}),
      },
      select: { id: true, blobKey: true },
      take: 100,
    });
    let n = 0;
    for (const r of rows) {
      if (r.blobKey) {
        try {
          await this.storage.remove(r.blobKey);
        } catch (e) {
          this.logger.warn(
            `выгрузка ${r.id}: файл не удалён (${(e as Error).name})`,
          );
          continue;
        }
      }
      await this.prisma.assistSiteExport.update({
        where: { id: r.id },
        data: { status: 'expired', blobKey: null },
        select: { id: true },
      });
      n++;
    }
    return n;
  }

  /** CSV выгрузки; null — больше exportMaxRows строк. */
  private async build(x: {
    siteId: string;
    kind: string;
    params: unknown;
    withText: boolean;
  }): Promise<{ text: string; rows: number } | null> {
    const site = await this.prisma.assistSite.findUnique({
      where: { siteId: x.siteId },
      select: { timezone: true },
    });
    const tz = siteTz(site?.timezone);
    const params = (x.params ?? {}) as { from?: unknown; to?: unknown };
    if (!validDay(params.from) || !validDay(params.to)) {
      throw new Error('bad_params');
    }
    const from = params.from;
    const to = params.to;
    const start = dayRangeUtc(from, tz).start;
    const end = dayRangeUtc(to, tz).end;
    const max = ANALYTICS_DEFAULTS.exportMaxRows;
    if (x.kind === 'daily') {
      const rows = await this.prisma.assistSiteDailyTotal.findMany({
        where: { siteId: x.siteId, group: 'all', day: { gte: from, lte: to } },
        orderBy: { day: 'asc' },
        take: max + 1,
      });
      if (rows.length > max) return null;
      const header = [
        'date',
        'dialogs',
        'resolved',
        'answers',
        'unknown',
        'handoffs',
        'handoffs_missed',
        'leads',
        'thumbs_up',
        'thumbs_down',
        'widget_views',
        'opens',
        'proactive_shown',
        'proactive_accepted',
        'cost_usd',
        'conversions',
        'direct',
        'assisted',
        'unassisted',
        'refunds',
        'value_verified',
        'value_page',
      ];
      const out: Cell[][] = rows.map((r) => {
        const c = sumConversions(r.conversions);
        return [
          r.day,
          r.dialogs,
          r.resolved,
          r.answers,
          r.unknown,
          r.handoffs,
          r.handoffsMissed,
          r.leads,
          r.thumbsUp,
          r.thumbsDown,
          r.widgetViews,
          r.opens,
          r.proactiveShown,
          r.proactiveAccepted,
          Number(r.costMicroUsd) / 1_000_000,
          c.direct + c.assisted + c.unassisted + c.unknown,
          c.direct,
          c.assisted,
          c.unassisted,
          c.refunds,
          c.verified,
          c.page,
        ];
      });
      return { text: csvRows(header, out), rows: out.length };
    }
    if (x.kind === 'conversions') {
      const rows = await this.prisma.assistSiteGoalEvent.findMany({
        where: { siteId: x.siteId, occurredAt: { gte: start, lt: end } },
        orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
        take: max + 1,
        select: {
          occurredAt: true,
          orderId: true,
          value: true,
          currency: true,
          status: true,
          trust: true,
          attribution: true,
          conversationId: true,
          path: true,
          source: true,
          goal: { select: { key: true, name: true } },
        },
      });
      if (rows.length > max) return null;
      const header = [
        'time',
        'goal',
        'goal_name',
        'order_id',
        'value',
        'currency',
        'status',
        'trust',
        'attribution',
        'dialog_id',
        'page',
        'source',
      ];
      const out: Cell[][] = rows.map((r) => [
        r.occurredAt.toISOString(),
        r.goal.key,
        r.goal.name,
        r.orderId,
        r.value === null ? null : Number(r.value),
        r.currency,
        r.status,
        r.trust,
        r.attribution,
        r.conversationId,
        r.path,
        r.source,
      ]);
      return { text: csvRows(header, out), rows: out.length };
    }
    // dialogs
    const convs = await this.prisma.assistSiteConversation.findMany({
      where: { siteId: x.siteId, createdAt: { gte: start, lt: end } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: max + 1,
      select: {
        id: true,
        createdAt: true,
        pageUrl: true,
        locale: true,
        outcome: true,
        openedBy: true,
        answers: true,
        flagged: true,
        suspicious: true,
        handoffState: true,
      },
    });
    if (convs.length > max) return null;
    const base = [
      'dialog_id',
      'time',
      'page',
      'lang',
      'outcome',
      'opened_by',
      'answers',
      'flagged',
      'suspicious',
      'handoff',
    ];
    const baseRow = (c: (typeof convs)[number]): Cell[] => [
      c.id,
      c.createdAt.toISOString(),
      c.pageUrl,
      c.locale,
      c.outcome,
      c.openedBy,
      c.answers,
      c.flagged,
      c.suspicious,
      c.handoffState,
    ];
    if (!x.withText) {
      const out = convs.map(baseRow);
      return { text: csvRows(base, out), rows: out.length };
    }
    const out: Cell[][] = [];
    const byId = new Map(convs.map((c) => [c.id, c]));
    const ids = convs.map((c) => c.id);
    for (let i = 0; i < ids.length; i += 500) {
      const msgs = await this.prisma.assistSiteMessage.findMany({
        where: { conversationId: { in: ids.slice(i, i + 500) } },
        orderBy: [
          { conversationId: 'asc' },
          { createdAt: 'asc' },
          { id: 'asc' },
        ],
        select: {
          conversationId: true,
          createdAt: true,
          role: true,
          text: true,
        },
      });
      for (const msg of msgs) {
        if (out.length >= max) return null;
        const c = byId.get(msg.conversationId);
        if (!c) continue;
        out.push([
          ...baseRow(c),
          msg.createdAt.toISOString(),
          msg.role,
          maskForJournal(msg.text),
        ]);
      }
    }
    return {
      text: csvRows([...base, 'message_time', 'role', 'text'], out),
      rows: out.length,
    };
  }
}

/** Сумма конверсий дня по всем целям (JSON свёртки). */
export function sumConversions(raw: unknown): {
  direct: number;
  assisted: number;
  unassisted: number;
  unknown: number;
  refunds: number;
  verified: number;
  page: number;
} {
  const s = {
    direct: 0,
    assisted: 0,
    unassisted: 0,
    unknown: 0,
    refunds: 0,
    verified: 0,
    page: 0,
  };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return s;
  for (const v of Object.values(raw as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue;
    const g = v as Record<string, unknown>;
    const n = (x: unknown) =>
      typeof x === 'number' && Number.isFinite(x) ? x : 0;
    s.direct += n(g.direct);
    s.assisted += n(g.assisted);
    s.unassisted += n(g.unassisted);
    s.unknown += n(g.unknown);
    s.refunds += n(g.refunds);
    const val = (g.value ?? {}) as Record<string, unknown>;
    s.verified = Math.round((s.verified + n(val.verified)) * 100) / 100;
    s.page = Math.round((s.page + n(val.page)) * 100) / 100;
  }
  return s;
}
